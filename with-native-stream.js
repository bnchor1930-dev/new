const { withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SOURCE_FILENAME = 'VisionStreamModule.m';

// PURE OBJECTIVE-C IMPLEMENTATION (No Swift Bridging Header required)
const OBJC_SOURCE_CODE = `
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreFoundation/CoreFoundation.h>
#import <ImageIO/ImageIO.h> // FIX 1: Required for compression constants

@interface VisionStreamModule : RCTEventEmitter <RCTBridgeModule, AVCaptureVideoDataOutputSampleBufferDelegate>
@end

@implementation VisionStreamModule {
    AVCaptureSession *_captureSession;
    NSOutputStream *_outputStream;
    dispatch_queue_t _cameraQueue;
    BOOL _isStreaming;
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
    _captureSession.sessionPreset = AVCaptureSessionPreset1920x1080;
    
    AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
    if (!device) return;
    
    // Force 60 FPS
    NSError *error = nil;
    if ([device lockForConfiguration:&error]) {
        device.activeVideoMinFrameDuration = CMTimeMake(1, 60);
        device.activeVideoMaxFrameDuration = CMTimeMake(1, 60);
        [device unlockForConfiguration];
    }

    AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:nil];
    if (input && [_captureSession canAddInput:input]) {
        [_captureSession addInput:input];
    }
    
    AVCaptureVideoDataOutput *output = [[AVCaptureVideoDataOutput alloc] init];
    output.alwaysDiscardsLateVideoFrames = YES;
    [output setSampleBufferDelegate:self queue:_cameraQueue];
    
    if ([_captureSession canAddOutput:output]) {
        [_captureSession addOutput:output];
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
    if (!_isStreaming || !_outputStream || ![_outputStream hasSpaceAvailable]) return;

    CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!imageBuffer) return;

    CIImage *ciImage = [CIImage imageWithCVPixelBuffer:imageBuffer];
    CIContext *context = [CIContext context]; // In prod, reuse this context
    
    // FIX 2: Use the correct constant (kCGImageDestinationLossyCompressionQuality) 
    // FIX 3: Cast it to NSString* for the dictionary key
    NSData *jpegData = [context JPEGRepresentationOfImage:ciImage 
                                              colorSpace:ciImage.colorSpace 
                                                 options:@{(__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @(0.6)}];
    
    if (!jpegData) return;

    // Protocol: [4-BYTE-SIZE] + [BODY]
    uint32_t length = (uint32_t)jpegData.length;
    uint32_t bigEndianLength = CFSwapInt32HostToBig(length);
    
    [_outputStream write:(const uint8_t *)&bigEndianLength maxLength:4];
    [_outputStream write:jpegData.bytes maxLength:jpegData.length];
}

@end
`;

const withNativeStream = (config) => {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const projectRoot = config.modRequest.projectRoot;
    const projectName = config.modRequest.projectName || "CameraaPro";

    // 1. Prepare Paths
    const iosDir = path.join(projectRoot, 'ios');
    const sourceDir = path.join(iosDir, projectName);

    if (!fs.existsSync(sourceDir)) {
      fs.mkdirSync(sourceDir, { recursive: true });
    }

    // 2. Write File
    const sourcePath = path.join(sourceDir, SOURCE_FILENAME);
    fs.writeFileSync(sourcePath, OBJC_SOURCE_CODE, 'utf8');

    // 3. Link to Xcode – more robust group lookup
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