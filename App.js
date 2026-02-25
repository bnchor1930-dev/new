import { useState, useEffect } from 'react';
import { 
  StyleSheet, 
  Text, 
  View, 
  TouchableOpacity, 
  NativeModules, 
  NativeEventEmitter,
  TextInput,
  SafeAreaView,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  Alert // Import native Alert
} from 'react-native';

// Import Camera solely for permission handling
import { Camera } from 'expo-camera';

// Safely access the native module
const { VisionStreamModule } = NativeModules;

export default function App() {
  const [streaming, setStreaming] = useState(false);
  const [ip, setIp] = useState("192.168.1.100");
  const [port, setPort] = useState("5000");
  const [statusMsg, setStatusMsg] = useState("Initializing...");
  const [hasPermission, setHasPermission] = useState(null);

  // 1. Request Camera Permissions on App Start
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Camera.requestCameraPermissionsAsync();
        setHasPermission(status === 'granted');
        if (status === 'granted') {
          setStatusMsg("Ready to Connect");
        } else {
          setStatusMsg("Camera Permission Denied");
          Alert.alert("Permission Error", "Camera access is required to stream video.");
        }
      } catch (e) {
        console.error("Permission request failed:", e);
      }
    })();
  }, []);

  // 2. Listen for Native Events (Stream Status)
  useEffect(() => {
    if (VisionStreamModule) {
      const eventEmitter = new NativeEventEmitter(VisionStreamModule);
      const subscription = eventEmitter.addListener('onStreamStatus', (event) => {
        if (event.status === 'active') setStatusMsg("Streaming Live (60 FPS)");
        if (event.status === 'stopped') setStatusMsg("Stream Stopped");
      });
      return () => subscription.remove();
    } else {
      setStatusMsg("Native Module Missing (Build Required)");
    }
  }, []);

  const toggleStream = () => {
    // Safety Check: Module existence
    if (!VisionStreamModule) {
      Alert.alert("Build Error", "Native Module not found. You must run a 'prebuild' and build a new IPA.");
      return;
    }

    // Safety Check: Permissions
    if (!hasPermission) {
      Alert.alert("Permission Error", "Please enable camera permissions in settings.");
      return;
    }

    if (streaming) {
      VisionStreamModule.stopSession();
      setStreaming(false);
    } else {
      // Safety Check: Input Validation
      const targetPort = parseInt(port, 10);
      if (isNaN(targetPort)) {
        Alert.alert("Invalid Input", "Port must be a number (e.g. 5000).");
        return;
      }
      
      VisionStreamModule.startSession(ip, targetPort);
      setStreaming(true);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      
      <View style={styles.header}>
        <Text style={styles.appTitle}>Cameraa Pro</Text>
        <View style={[styles.badge, streaming ? styles.badgeLive : styles.badgeReady]}>
          <View style={[styles.dot, streaming ? styles.dotLive : styles.dotReady]} />
          <Text style={[styles.badgeText, streaming ? styles.textLive : styles.textReady]}>
            {streaming ? 'ON AIR' : 'STANDBY'}
          </Text>
        </View>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.content}>
        
        <View style={styles.card}>
          <Text style={styles.label}>Target IP Address</Text>
          <TextInput 
            style={styles.input} 
            value={ip}
            onChangeText={setIp}
            placeholder="192.168.1.100"
            keyboardType="numeric"
            autoCapitalize="none"
          />
          
          <Text style={styles.label}>Target Port</Text>
          <TextInput 
            style={styles.input} 
            value={port}
            onChangeText={setPort}
            placeholder="5000"
            keyboardType="numeric"
          />
        </View>

        <View style={styles.statusContainer}>
          <Text style={styles.statusText}>{statusMsg}</Text>
        </View>

        <TouchableOpacity
          activeOpacity={0.8}
          style={[styles.mainButton, streaming ? styles.buttonStop : styles.buttonStart]}
          onPress={toggleStream}
        >
          <View style={styles.iconContainer}>
            <View style={[styles.iconShape, streaming ? styles.iconStop : styles.iconStart]} />
          </View>
          <Text style={[styles.buttonText, streaming ? styles.textStop : styles.textStart]}>
            {streaming ? 'STOP STREAM' : 'START STREAM'}
          </Text>
        </TouchableOpacity>

      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 40,
  },
  appTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#000',
    letterSpacing: -0.5,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    borderWidth: 1,
  },
  badgeLive: {
    backgroundColor: '#FFE5E5',
    borderColor: '#FF3B30',
  },
  badgeReady: {
    backgroundColor: '#E5F9E7',
    borderColor: '#34C759',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  dotLive: { backgroundColor: '#FF3B30' },
  dotReady: { backgroundColor: '#34C759' },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  textLive: { color: '#FF3B30' },
  textReady: { color: '#34C759' },

  content: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 4,
    marginBottom: 30,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  input: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5EA',
    paddingVertical: 12,
    marginBottom: 24,
  },
  statusContainer: {
    alignItems: 'center',
    marginBottom: 40,
  },
  statusText: {
    fontSize: 16,
    color: '#8E8E93',
    fontWeight: '500',
  },
  mainButton: {
    height: 70,
    borderRadius: 35,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 8,
  },
  buttonStart: {
    backgroundColor: '#007AFF',
  },
  buttonStop: {
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#FF3B30',
  },
  iconContainer: {
    marginRight: 12,
  },
  iconShape: {
    backgroundColor: '#fff',
  },
  iconStart: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderLeftWidth: 12,
    borderRightWidth: 0,
    borderBottomWidth: 8,
    borderTopWidth: 8,
    borderLeftColor: '#fff',
    borderRightColor: 'transparent',
    borderBottomColor: 'transparent',
    borderTopColor: 'transparent',
  },
  iconStop: {
    width: 14,
    height: 14,
    backgroundColor: '#FF3B30',
    borderRadius: 2,
  },
  buttonText: {
    fontSize: 18,
    fontWeight: '700',
  },
  textStart: { color: '#fff' },
  textStop: { color: '#FF3B30' },
});