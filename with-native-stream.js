const { withXcodeProject, withInfoPlist } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SOURCE_FILENAME = 'VisionStreamModule.m';

const OBJC_SOURCE_CODE = `
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreFoundation/CoreFoundation.h>
#import <ImageIO/ImageIO.h>

@interface VisionStreamModule : RCTEventEmitter <RCTBridgeModule, AVCaptureVideoDataOutputSampleBufferDelegate>
@end

@implementation VisionStreamModule {
    AVCaptureSession *_captureSession;
    AVCaptureDeviceInput *_currentInput;
    AVCaptureVideoDataOutput *_currentOutput;
    
    NSOutputStream *_outputStream;
    NSInputStream *_inputStream; // NEW: To hear the server
    
    dispatch_queue_t _cameraQueue;
    dispatch_queue_t _networkQueue; // NEW: To listen without blocking video
    
    BOOL _isStreaming;
    CIContext *_ciContext;
    NSString *_currentLens;
}

RCT_EXPORT_MODULE();

- (NSArray<NSString *> *)supportedEvents {
    return @[@"onStreamStatus", @"onStreamError"];
}

+ (BOOL)requiresMainQueueSetup {
    return NO;
}

- (instancetype)init {
    if (self = [super init]) {
        _cameraQueue = dispatch_queue_create("com.vision.cameraQueue", DISPATCH_QUEUE_SERIAL);
        _networkQueue = dispatch_queue_create("com.vision.networkQueue", DISPATCH_QUEUE_SERIAL);
        _isStreaming = NO;
        _ciContext = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer: @(NO)}];
        _currentLens = @"wide";
    }
    return self;
}

RCT_EXPORT_METHOD(startSession:(NSString *)host port:(NSInteger)port) {
    if (_isStreaming) return;

    dispatch_async(_cameraQueue, ^{
        [self setupCameraWithLens:self->_currentLens];
        [self connectTCP:host port:port];
        
        if (self->_captureSession) {
            [self->_captureSession startRunning];
            self->_isStreaming = YES;
            [self sendEventWithName:@"onStreamStatus" body:@{@"status": @"active"}];
            
            // Start Listening for Server Commands
            dispatch_async(self->_networkQueue, ^{
                [self listenForCommands];
            });
            
        } else {
            [self sendEventWithName:@"onStreamError" body:@{@"error": @"Camera failed to start"}];
        }
    });
}

RCT_EXPORT_METHOD(stopSession) {
    dispatch_async(_cameraQueue, ^{
        self->_isStreaming = NO;
        if (self->_captureSession) [self->_captureSession stopRunning];
        [self closeTCP];
        [self sendEventWithName:@"onStreamStatus" body:@{@"status": @"stopped"}];
    });
}

// Manual Override from App UI
RCT_EXPORT_METHOD(setLens:(NSString *)lensType) {
    dispatch_async(_cameraQueue, ^{
        [self switchLensInternal:lensType];
    });
}

RCT_EXPORT_METHOD(setOrientation:(NSString *)orientation) {
    dispatch_async(_cameraQueue, ^{
        [self setOrientationInternal:orientation];
    });
}

// Internal Logic (Used by both UI and Remote Server)
- (void)switchLensInternal:(NSString *)lensType {
    if ([_currentLens isEqualToString:lensType]) return;
    _currentLens = lensType;
    if (_isStreaming) {
        [_captureSession stopRunning];
        [self setupCameraWithLens:lensType];
        [_captureSession startRunning];
    }
}

- (void)setOrientationInternal:(NSString *)orientation {
    if (!_currentOutput) return;
    AVCaptureConnection *conn = [_currentOutput connectionWithMediaType:AVMediaTypeVideo];
    if (conn.isVideoOrientationSupported) {
        if ([orientation isEqualToString:@"portrait"]) conn.videoOrientation = AVCaptureVideoOrientationPortrait;
        else if ([orientation isEqualToString:@"landscapeRight"]) conn.videoOrientation = AVCaptureVideoOrientationLandscapeRight;
        else if ([orientation isEqualToString:@"landscapeLeft"]) conn.videoOrientation = AVCaptureVideoOrientationLandscapeLeft;
        else if ([orientation isEqualToString:@"upsideDown"]) conn.videoOrientation = AVCaptureVideoOrientationPortraitUpsideDown;
    }
}

- (void)rotateNext {
    if (!_currentOutput) return;
    AVCaptureConnection *conn = [_currentOutput connectionWithMediaType:AVMediaTypeVideo];
    if (conn.isVideoOrientationSupported) {
        AVCaptureVideoOrientation current = conn.videoOrientation;
        AVCaptureVideoOrientation next = (current == AVCaptureVideoOrientationLandscapeLeft) ? AVCaptureVideoOrientationPortrait : current + 1;
        conn.videoOrientation = next;
    }
}

- (void)setupCameraWithLens:(NSString *)lensType {
    if (!_captureSession) {
        _captureSession = [[AVCaptureSession alloc] init];
    } else {
        [_captureSession beginConfiguration];
        if (_currentInput) [_captureSession removeInput:_currentInput];
        if (_currentOutput) [_captureSession removeOutput:_currentOutput];
    }
    
    AVCaptureDevice *device = nil;
    if ([lensType isEqualToString:@"ultra"]) {
        device = [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInUltraWideCamera mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionBack];
    }
    if (!device) {
        device = [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionBack];
    }
    
    NSError *error = nil;
    _currentInput = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
    if (_currentInput && [_captureSession canAddInput:_currentInput]) {
        [_captureSession addInput:_currentInput];
    }
    
    _currentOutput = [[AVCaptureVideoDataOutput alloc] init];
    _currentOutput.alwaysDiscardsLateVideoFrames = YES;
    _currentOutput.videoSettings = @{(id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA)};
    [_currentOutput setSampleBufferDelegate:self queue:_cameraQueue];
    
    if ([_captureSession canAddOutput:_currentOutput]) {
        [_captureSession addOutput:_currentOutput];
    }

    AVCaptureDeviceFormat *bestFormat = nil;
    for (AVCaptureDeviceFormat *format in [device formats]) {
        CMVideoDimensions dim = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
        if (dim.width >= 1920 && dim.height >= 1080) {
            for (AVFrameRateRange *range in format.videoSupportedFrameRateRanges) {
                if (range.maxFrameRate >= 60) {
                    bestFormat = format;
                    break;
                }
            }
        }
        if (bestFormat) break;
    }

    if (bestFormat) {
        if ([device lockForConfiguration:&error]) {
            device.activeFormat = bestFormat;
            device.activeVideoMinFrameDuration = CMTimeMake(1, 60);
            device.activeVideoMaxFrameDuration = CMTimeMake(1, 60);
            [device unlockForConfiguration];
        }
    } else {
        _captureSession.sessionPreset = AVCaptureSessionPreset1920x1080;
    }
    
    AVCaptureConnection *conn = [_currentOutput connectionWithMediaType:AVMediaTypeVideo];
    if (conn.isVideoOrientationSupported) {
        conn.videoOrientation = AVCaptureVideoOrientationPortrait;
    }

    [_captureSession commitConfiguration];
}

- (void)connectTCP:(NSString *)host port:(NSInteger)port {
    CFReadStreamRef readStream;
    CFWriteStreamRef writeStream;
    CFStreamCreatePairWithSocketToHost(NULL, (__bridge CFStringRef)host, (UInt32)port, &readStream, &writeStream);
    
    _outputStream = (__bridge_transfer NSOutputStream *)writeStream;
    _inputStream = (__bridge_transfer NSInputStream *)readStream;
    
    [_outputStream open];
    [_inputStream open];
}

- (void)closeTCP {
    if (_outputStream) { [_outputStream close]; _outputStream = nil; }
    if (_inputStream) { [_inputStream close]; _inputStream = nil; }
}

// NEW: The "Ear" of the application
- (void)listenForCommands {
    uint8_t buffer[1];
    while (_isStreaming && _inputStream && [_inputStream streamStatus] == NSStreamStatusOpen) {
        if ([_inputStream hasBytesAvailable]) {
            NSInteger bytesRead = [_inputStream read:buffer maxLength:1];
            if (bytesRead > 0) {
                char command = (char)buffer[0];
                dispatch_async(_cameraQueue, ^{
                    // REMOTE CONTROL LOGIC
                    if (command == 'W') [self switchLensInternal:@"wide"];
                    if (command == 'U') [self switchLensInternal:@"ultra"];
                    if (command == 'R') [self rotateNext];
                });
            }
        } else {
            [NSThread sleepForTimeInterval:0.05];
        }
    }
}

- (BOOL)writeAllBytes:(const void *)buffer length:(NSUInteger)length {
    if (!_outputStream || _outputStream.streamStatus != NSStreamStatusOpen) return NO;
    NSUInteger bytesWritten = 0;
    const uint8_t *bytePtr = (const uint8_t *)buffer;
    while (bytesWritten < length) {
        if ([_outputStream hasSpaceAvailable]) {
            NSInteger written = [_outputStream write:&bytePtr[bytesWritten] maxLength:(length - bytesWritten)];
            if (written == -1) return NO;
            if (written > 0) bytesWritten += written;
        } else {
            [NSThread sleepForTimeInterval:0.001];
        }
    }
    return YES;
}

- (void)captureOutput:(AVCaptureOutput *)output didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer fromConnection:(AVCaptureConnection *)connection {
    if (!_isStreaming || !_outputStream) return;
    CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!imageBuffer) return;
    CIImage *ciImage = [CIImage imageWithCVPixelBuffer:imageBuffer];
    NSData *jpegData = [_ciContext JPEGRepresentationOfImage:ciImage 
                                              colorSpace:ciImage.colorSpace 
                                                 options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @(0.5)}];
    if (!jpegData) return;
    uint32_t length = (uint32_t)jpegData.length;
    uint32_t bigEndianLength = CFSwapInt32HostToBig(length);
    NSMutableData *packet = [NSMutableData dataWithCapacity:length + 4];
    [packet appendBytes:&bigEndianLength length:4];
    [packet appendData:jpegData];
    [self writeAllBytes:packet.bytes length:packet.length];
}

@end
`;

const withNativeStream = (config) => {
  config = withInfoPlist(config, (config) => {
    config.modResults.NSLocalNetworkUsageDescription = "Connect to PC for video streaming";
    config.modResults.NSCameraUsageDescription = "Capture video for streaming";
    return config;
  });

  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const projectRoot = config.modRequest.projectRoot;
    const projectName = config.modRequest.projectName || "CameraaPro";
    const iosDir = path.join(projectRoot, 'ios');
    const sourceDir = path.join(iosDir, projectName);

    if (!fs.existsSync(sourceDir)) {
      fs.mkdirSync(sourceDir, { recursive: true });
    }

    const sourcePath = path.join(sourceDir, SOURCE_FILENAME);
    fs.writeFileSync(sourcePath, OBJC_SOURCE_CODE, 'utf8');

    let mainGroup = project.findPBXGroupKey({ name: projectName });
    if (!mainGroup) {
      mainGroup = project.findPBXGroupKey({ name: 'App' }) ||
                  project.pbxGroupByPath(projectName) ||
                  project.getPBXProjectSection()[project.getFirstProjectKey()].mainGroup;
    }

    const targetUuid = project.getFirstTarget().uuid;
    if (!project.hasFile(SOURCE_FILENAME)) {
      project.addSourceFile(
        path.join(projectName, SOURCE_FILENAME),
        { target: targetUuid },
        mainGroup
      );
    }
    return config;
  });
};

module.exports = withNativeStream;