import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, NativeModules, NativeEventEmitter, SafeAreaView, StatusBar, Alert, Dimensions } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { BlurView } from 'expo-blur';

const { VisionStreamModule } = NativeModules;
const { width } = Dimensions.get('window');

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [serverInfo, setServerInfo] = useState({ ip: '', port: '' });
  const [status, setStatus] = useState("SCAN QR CODE");

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
    VisionStreamModule.startSession(ip, port);
  };

  const stopStream = () => {
    VisionStreamModule.stopSession();
    setStreaming(false);
    setScanned(false);
    setStatus("SCAN QR CODE");
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

        <View style={styles.footer}>
          {streaming ? (
            <TouchableOpacity style={styles.stopBtn} onPress={stopStream}>
              <Text style={styles.btnText}>TERMINATE UPLINK</Text>
            </TouchableOpacity>
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
  footer: { padding: 30, alignItems: 'center' },
  hintText: { color: 'rgba(255,255,255,0.6)', letterSpacing: 2, fontSize: 12 },
  stopBtn: { backgroundColor: 'rgba(255, 0, 0, 0.3)', borderColor: '#FF0000', borderWidth: 1, paddingVertical: 15, paddingHorizontal: 40, borderRadius: 8 },
  btnText: { color: '#FF0000', fontWeight: 'bold', letterSpacing: 1 },
  activeText: { color: '#00FF00', fontSize: 24, fontWeight: '900', textAlign: 'center', marginTop: 100 },
  ipText: { color: '#555', textAlign: 'center', marginTop: 10 },
  pulseContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  pulse: { width: 200, height: 200, borderRadius: 100, borderWidth: 1, borderColor: '#00FF00', opacity: 0.2 }
});