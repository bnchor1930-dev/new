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
        // High priority queue for 60fps processing
        _cameraQueue = dispatch_queue_create("com.vision.cameraQueue", DISPATCH_QUEUE_SERIAL);
        _isStreaming = NO;
        // Metal-backed CIContext for fastest JPEG compression
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
    
    // 1. Setup Input
    AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
    if (!device) return;
    
    NSError *error = nil;
    AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
    if (!input || ![_captureSession canAddInput:input]) return;
    [_captureSession addInput:input];
    
    // 2. Setup Output
    AVCaptureVideoDataOutput *output = [[AVCaptureVideoDataOutput alloc] init];
    output.alwaysDiscardsLateVideoFrames = YES;
    
    // Request BGRA for faster processing
    output.videoSettings = @{(id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA)};
    [output setSampleBufferDelegate:self queue:_cameraQueue];
    
    if (![_captureSession canAddOutput:output]) return;
    [_captureSession addOutput:output];

    // 3. CRITICAL FIX: Find a format that actually supports 60 FPS at 1080p
    AVCaptureDeviceFormat *bestFormat = nil;
    AVFrameRateRange *bestFrameRateRange = nil;

    for (AVCaptureDeviceFormat *format in [device formats]) {
        CMVideoDimensions dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
        
        // Look for 1920x1080
        if (dimensions.width == 1920 && dimensions.height == 1080) {
            for (AVFrameRateRange *range in format.videoSupportedFrameRateRanges) {
                if (range.maxFrameRate >= 60) {
                    bestFormat = format;
                    bestFrameRateRange = range;
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
        // Fallback for older devices (will default to 30fps usually)
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

- (void)captureOutput:(AVCaptureOutput *)output didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer fromConnection:(AVCaptureConnection *)connection {
    // Fail fast if not streaming or buffer full
    if (!_isStreaming || !_outputStream || ![_outputStream hasSpaceAvailable]) return;

    CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!imageBuffer) return;

    // Use CIImage from CVImageBuffer (Fastest path)
    CIImage *ciImage = [CIImage imageWithCVPixelBuffer:imageBuffer];
    
    // Compress to JPEG (0.5 quality is sweet spot for 60fps latency vs quality)
    NSData *jpegData = [_ciContext JPEGRepresentationOfImage:ciImage 
                                              colorSpace:ciImage.colorSpace 
                                                 options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @(0.5)}];
    
    if (!jpegData) return;

    // Protocol: [4 bytes length][JPEG Body]
    uint32_t length = (uint32_t)jpegData.length;
    uint32_t bigEndianLength = CFSwapInt32HostToBig(length);
    
    // Write in one go if possible, or chunks (simplified here for speed)
    [_outputStream write:(const uint8_t *)&bigEndianLength maxLength:4];
    [_outputStream write:jpegData.bytes maxLength:jpegData.length];
}

@end
`;

const withNativeStream = (config) => {
  // 1. Add Local Network Permission (Required for iOS 14+ or app crashes/blocks on socket connect)
  config = withInfoPlist(config, (config) => {
    config.modResults.NSLocalNetworkUsageDescription = "Connect to PC for video streaming";
    config.modResults.NSCameraUsageDescription = "Capture video for streaming";
    return config;
  });

  // 2. Inject Native Code
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