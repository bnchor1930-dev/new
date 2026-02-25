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
    NSOutputStream *_outputStream;
    dispatch_queue_t _cameraQueue;
    BOOL _isStreaming;
    CIContext *_ciContext;
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
        _isStreaming = NO;
        // Software renderer is safer for background processing, though slightly slower
        _ciContext = [CIContext contextWithOptions:@{kCIContextUseSoftwareRenderer: @(NO)}];
    }
    return self;
}

RCT_EXPORT_METHOD(startSession:(NSString *)host port:(NSInteger)port) {
    if (_isStreaming) return;

    dispatch_async(_cameraQueue, ^{
        [self setupCamera];
        [self connectTCP:host port:port];
        
        if (self->_captureSession) {
            [self->_captureSession startRunning];
            self->_isStreaming = YES;
            [self sendEventWithName:@"onStreamStatus" body:@{@"status": @"active"}];
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

- (void)setupCamera {
    if (_captureSession) return;
    
    _captureSession = [[AVCaptureSession alloc] init];
    
    AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
    if (!device) return;
    
    NSError *error = nil;
    AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
    if (!input || ![_captureSession canAddInput:input]) return;
    [_captureSession addInput:input];
    
    AVCaptureVideoDataOutput *output = [[AVCaptureVideoDataOutput alloc] init];
    output.alwaysDiscardsLateVideoFrames = YES;
    
    // BGRA is optimal for CIContext
    output.videoSettings = @{(id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA)};
    [output setSampleBufferDelegate:self queue:_cameraQueue];
    
    if (![_captureSession canAddOutput:output]) return;
    [_captureSession addOutput:output];

    // Find best 60FPS format
    AVCaptureDeviceFormat *bestFormat = nil;
    for (AVCaptureDeviceFormat *format in [device formats]) {
        CMVideoDimensions dim = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
        if (dim.width == 1920 && dim.height == 1080) {
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
}

- (void)connectTCP:(NSString *)host port:(NSInteger)port {
    CFReadStreamRef readStream;
    CFWriteStreamRef writeStream;
    CFStreamCreatePairWithSocketToHost(NULL, (__bridge CFStringRef)host, (UInt32)port, &readStream, &writeStream);
    
    _outputStream = (__bridge_transfer NSOutputStream *)writeStream;
    [_outputStream open];
}

- (void)closeTCP {
    if (_outputStream) {
        [_outputStream close];
        _outputStream = nil;
    }
}

// Helper to write ALL bytes. If buffer fills, it waits.
- (BOOL)writeAllBytes:(const void *)buffer length:(NSUInteger)length {
    if (!_outputStream || _outputStream.streamStatus != NSStreamStatusOpen) return NO;
    
    NSUInteger bytesWritten = 0;
    const uint8_t *bytePtr = (const uint8_t *)buffer;
    
    while (bytesWritten < length) {
        if ([_outputStream hasSpaceAvailable]) {
            NSInteger written = [_outputStream write:&bytePtr[bytesWritten] maxLength:(length - bytesWritten)];
            if (written == -1) {
                return NO; // Error
            }
            if (written > 0) {
                bytesWritten += written;
            }
        } else {
            // Wait slightly to prevent CPU spinning, but don't drop packet
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
    
    // Lowered quality slightly to 0.4 to prevent network congestion (WiFi bottleneck)
    // 0.4 is still very good visually but halves the bandwidth vs 0.6
    NSData *jpegData = [_ciContext JPEGRepresentationOfImage:ciImage 
                                              colorSpace:ciImage.colorSpace 
                                                 options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @(0.4)}];
    
    if (!jpegData) return;

    uint32_t length = (uint32_t)jpegData.length;
    uint32_t bigEndianLength = CFSwapInt32HostToBig(length);
    
    // Combine Header + Body into one buffer to ensure atomicity
    NSMutableData *packet = [NSMutableData dataWithCapacity:length + 4];
    [packet appendBytes:&bigEndianLength length:4];
    [packet appendData:jpegData];
    
    // Send critical packet
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