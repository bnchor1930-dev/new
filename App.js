import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, NativeModules, NativeEventEmitter, SafeAreaView, StatusBar, Alert, Dimensions } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { BlurView } from 'expo-blur';

const { VisionStreamModule } = NativeModules;
const { width } = Dimensions.get('window');

const ROTATIONS = ['portrait', 'landscapeRight', 'upsideDown', 'landscapeLeft'];

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [serverInfo, setServerInfo] = useState({ ip: '', port: '' });
  const [status, setStatus] = useState("SCAN QR CODE");
  
  // UI State for Active Controls
  const [lens, setLens] = useState('wide'); // 'wide' or 'ultra'
  const [rotationIdx, setRotationIdx] = useState(0);
  const [zoom, setZoom] = useState(1.0); // NEW: State for current zoom

  useEffect(() => {
    if (!permission) requestPermission();
  }, [permission]);

  useEffect(() => {
    const eventEmitter = new NativeEventEmitter(VisionStreamModule);
    
    const eventListener = eventEmitter.addListener('onStreamStatus', (event) => {
      if (event.status === 'active') setStatus(`STREAMING TO ${serverInfo.ip}`);
      if (event.status === 'stopped') setStatus("DISCONNECTED");
    });
    
    const errorListener = eventEmitter.addListener('onStreamError', (event) => {
      Alert.alert("Stream Error", event.error);
      setStreaming(false);
      setScanned(false);
      setStatus("ERROR - SCAN AGAIN");
    });

    return () => {
      eventListener.remove();
      errorListener.remove();
    };
  }, [serverInfo]);

  const handleBarCodeScanned = ({ data }) => {
    if (scanned || streaming) return;
    try {
      const regex = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)/;
      const match = data.match(regex);
      if (match) {
        const ip = match[1];
        const port = parseInt(match[2], 10);
        setScanned(true);
        setServerInfo({ ip, port });
        startStream(ip, port);
        setStatus("CONNECTING...");
      }
    } catch (e) {}
  };

  const startStream = (ip, port) => {
    setStreaming(true);
    // Start Native Session
    VisionStreamModule.startSession(ip, port);
    
    // Apply Default Settings immediately
    VisionStreamModule.setLens(lens);
    VisionStreamModule.setOrientation(ROTATIONS[rotationIdx]);
    VisionStreamModule.setZoom(zoom); // NEW: Apply current zoom on start
  };

  const stopStream = () => {
    VisionStreamModule.stopSession();
    setStreaming(false);
    setScanned(false);
    setStatus("SCAN QR CODE");
  };

  const toggleLens = (type) => {
    setLens(type);
    // Reset zoom when switching lenses to avoid unexpected hardware behavior
    setZoom(1.0);
    if (streaming) {
      VisionStreamModule.setLens(type);
      VisionStreamModule.setZoom(1.0);
    }
  };

  const cycleRotation = () => {
    const nextIdx = (rotationIdx + 1) % 4;
    setRotationIdx(nextIdx);
    if (streaming) VisionStreamModule.setOrientation(ROTATIONS[nextIdx]);
  };

  // NEW: Zoom handlers
  const adjustZoom = (amount) => {
    setZoom((prevZoom) => {
      // Clamp zoom between 1.0 and 10.0 (or typical max digital zoom)
      let newZoom = Math.max(1.0, Math.min(prevZoom + amount, 10.0));
      // Fix floating point precision issues (e.g. 1.1 + 0.1 = 1.2000000000000002)
      newZoom = parseFloat(newZoom.toFixed(1));
      if (streaming) VisionStreamModule.setZoom(newZoom);
      return newZoom;
    });
  };

  if (!permission || !permission.granted) {
    return (
      <View style={styles.container}>
        <TouchableOpacity onPress={requestPermission} style={styles.stopBtn}>
          <Text style={styles.btnText}>GRANT CAMERA ACCESS</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      
      {!streaming && (
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        />
      )}

      {streaming && (
        <View style={[styles.container, {backgroundColor: '#000'}]}>
          <Text style={styles.activeText}>STREAM ACTIVE</Text>
          <Text style={styles.ipText}>{serverInfo.ip}:{serverInfo.port}</Text>
          <Text style={styles.infoText}>{lens.toUpperCase()} LENS | {ROTATIONS[rotationIdx].toUpperCase()} | {zoom.toFixed(1)}x ZOOM</Text>
          
          <View style={styles.pulseContainer}>
            <View style={styles.pulse} />
          </View>
        </View>
      )}

      <SafeAreaView style={styles.hud}>
        <BlurView intensity={30} tint="dark" style={styles.header}>
          <View style={styles.statusDot} backgroundColor={streaming ? '#00FF00' : '#FF0000'} />
          <Text style={styles.statusText}>{status}</Text>
        </BlurView>

        {!streaming && (
          <View style={styles.scanFrame}>
            <View style={[styles.corner, styles.tl]} />
            <View style={[styles.corner, styles.tr]} />
            <View style={[styles.corner, styles.bl]} />
            <View style={[styles.corner, styles.br]} />
          </View>
        )}

        {/* CONTROLS FOOTER */}
        <View style={styles.footer}>
          {streaming ? (
            <View style={styles.controlPanel}>
              
              {/* Lens Selection Row */}
              <View style={styles.lensRow}>
                <TouchableOpacity 
                  style={[styles.lensBtn, lens === 'wide' && styles.lensBtnActive]} 
                  onPress={() => toggleLens('wide')}>
                  <Text style={[styles.lensText, lens === 'wide' && styles.lensTextActive]}>1x</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={[styles.lensBtn, lens === 'ultra' && styles.lensBtnActive]} 
                  onPress={() => toggleLens('ultra')}>
                  <Text style={[styles.lensText, lens === 'ultra' && styles.lensTextActive]}>0.5x</Text>
                </TouchableOpacity>
              </View>

              {/* NEW: Zoom Controls Row */}
              <View style={styles.zoomRow}>
                <TouchableOpacity style={styles.zoomBtn} onPress={() => adjustZoom(-0.1)}>
                  <Text style={styles.zoomBtnText}>-</Text>
                </TouchableOpacity>
                <Text style={styles.zoomDisplay}>{zoom.toFixed(1)}x</Text>
                <TouchableOpacity style={styles.zoomBtn} onPress={() => adjustZoom(0.1)}>
                  <Text style={styles.zoomBtnText}>+</Text>
                </TouchableOpacity>
              </View>

              {/* Rotation Control */}
              <TouchableOpacity style={styles.rotateBtn} onPress={cycleRotation}>
                <Text style={styles.btnText}>ROTATE 90°</Text>
              </TouchableOpacity>

              {/* Kill Switch */}
              <TouchableOpacity style={styles.stopBtn} onPress={stopStream}>
                <Text style={styles.btnText}>TERMINATE</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={styles.hintText}>ALIGN QR CODE TO CONNECT</Text>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  hud: { flex: 1, justifyContent: 'space-between' },
  header: { flexDirection: 'row', alignItems: 'center', margin: 16, padding: 16, borderRadius: 16, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  statusText: { color: '#00FF00', fontFamily: 'Courier', fontWeight: 'bold' },
  scanFrame: { width: width * 0.7, height: width * 0.7, alignSelf: 'center', justifyContent: 'center', alignItems: 'center' },
  corner: { position: 'absolute', width: 20, height: 20, borderColor: '#00FF00', borderWidth: 4 },
  tl: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0 },
  tr: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0 },
  bl: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0 },
  br: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0 },
  footer: { padding: 20, alignItems: 'center' },
  hintText: { color: 'rgba(255,255,255,0.6)', letterSpacing: 2, fontSize: 12 },
  
  controlPanel: { width: '100%', alignItems: 'center', gap: 10 },
  lensRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  lensBtn: { width: 60, height: 40, borderRadius: 20, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#555' },
  lensBtnActive: { backgroundColor: '#00FF00', borderColor: '#00FF00' },
  lensText: { color: '#AAA', fontWeight: 'bold' },
  lensTextActive: { color: '#000' },
  
  // NEW: Zoom styles
  zoomRow: { flexDirection: 'row', alignItems: 'center', gap: 20, marginBottom: 10, backgroundColor: '#222', paddingHorizontal: 20, paddingVertical: 5, borderRadius: 25, borderWidth: 1, borderColor: '#444' },
  zoomBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  zoomBtnText: { color: '#00FF00', fontSize: 24, fontWeight: 'bold' },
  zoomDisplay: { color: '#FFF', fontSize: 16, fontWeight: 'bold', width: 40, textAlign: 'center' },

  rotateBtn: { width: '100%', backgroundColor: '#222', padding: 15, borderRadius: 8, alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#444' },
  stopBtn: { width: '100%', backgroundColor: 'rgba(255, 0, 0, 0.3)', borderColor: '#FF0000', borderWidth: 1, paddingVertical: 15, borderRadius: 8, alignItems: 'center' },
  btnText: { color: '#FF0000', fontWeight: 'bold', letterSpacing: 1 },
  
  activeText: { color: '#00FF00', fontSize: 24, fontWeight: '900', textAlign: 'center', marginTop: 100 },
  ipText: { color: '#555', textAlign: 'center', marginTop: 10 },
  infoText: { color: '#333', textAlign: 'center', marginTop: 5, fontSize: 12 },
  pulseContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  pulse: { width: 200, height: 200, borderRadius: 100, borderWidth: 1, borderColor: '#00FF00', opacity: 0.2 }
});