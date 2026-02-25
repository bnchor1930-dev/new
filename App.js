import customtkinter as ctk
from PIL import Image, ImageTk
import socket
import threading
import cv2
import numpy as np
import qrcode
import struct
import time

PORT = 5000
BG_COLOR = "#000000"     
TEXT_COLOR = "#FFFFFF"

ctk.set_appearance_mode("Dark")
ctk.set_default_color_theme("blue")

class MetroServer(ctk.CTk):
    def __init__(self):
        super().__init__()

        self.title("VISION UPLINK // SERVER")
        self.geometry("1000x700")
        self.configure(fg_color=BG_COLOR)
        
        self.running = True
        self.current_ip = self.get_local_ip()
        self.frames = 0
        self.fps_start = time.time()

        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        # === LEFT PANEL ===
        self.sidebar = ctk.CTkFrame(self, width=250, corner_radius=0, fg_color="#1a1a1a")
        self.sidebar.grid(row=0, column=0, sticky="nsew")
        self.sidebar.grid_propagate(False)

        ctk.CTkLabel(self.sidebar, text="VISION\nUPLINK", font=("Arial Black", 24), text_color="#00FF00", justify="left").pack(pady=40, padx=20, anchor="w")
        
        self.status_label = ctk.CTkLabel(self.sidebar, text="WAITING...", font=("Consolas", 14), text_color="yellow")
        self.status_label.pack(pady=10, padx=20, anchor="w")
        
        ctk.CTkLabel(self.sidebar, text=f"IP: {self.current_ip}", text_color="#888").pack(padx=20, anchor="w")

        self.qr_label = ctk.CTkLabel(self.sidebar, text="")
        self.qr_label.pack(pady=40)
        self.generate_qr()

        self.fps_label = ctk.CTkLabel(self.sidebar, text="FPS: 0", font=("Consolas", 30), text_color="#00FF00")
        self.fps_label.pack(side="bottom", pady=40, padx=20, anchor="w")

        # === RIGHT PANEL (VIDEO) ===
        self.video_frame = ctk.CTkFrame(self, fg_color="#000000")
        self.video_frame.grid(row=0, column=1, sticky="nsew", padx=0, pady=0)
        
        self.feed_label = ctk.CTkLabel(self.video_frame, text="NO SIGNAL", text_color="#333", font=("Arial", 20))
        self.feed_label.place(relx=0.5, rely=0.5, anchor="center")

        self.thread = threading.Thread(target=self.start_server, daemon=True)
        self.thread.start()

    def get_local_ip(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        except: return "127.0.0.1"

    def generate_qr(self):
        qr = qrcode.QRCode(box_size=6, border=2)
        qr.add_data(f"{self.current_ip}:{PORT}")
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white").get_image()
        tk_img = ctk.CTkImage(light_image=img, size=(180, 180))
        self.qr_label.configure(image=tk_img)

    def start_server(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        server.bind(('0.0.0.0', PORT))
        server.listen(1)

        while self.running:
            try:
                conn, addr = server.accept()
                self.status_label.configure(text=f"CONNECTED:\n{addr[0]}", text_color="#00FF00")
                self.feed_label.configure(text="")
                
                while self.running:
                    # 1. Read Length
                    len_data = self.recv_bytes(conn, 4)
                    if not len_data: break
                    length = struct.unpack('>I', len_data)[0]

                    # 2. Read JPEG
                    jpeg_data = self.recv_bytes(conn, length)
                    if not jpeg_data: break

                    # 3. Decode
                    np_arr = np.frombuffer(jpeg_data, dtype=np.uint8)
                    frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

                    if frame is not None:
                        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                        pil_img = Image.fromarray(rgb)
                        
                        # Smart Resize Logic: Fit to window while maintaining aspect ratio
                        disp_w = self.video_frame.winfo_width()
                        disp_h = self.video_frame.winfo_height()
                        
                        img_w, img_h = pil_img.size
                        ratio = min(disp_w/img_w, disp_h/img_h)
                        new_w = int(img_w * ratio)
                        new_h = int(img_h * ratio)
                        
                        ctk_img = ctk.CTkImage(light_image=pil_img, size=(new_w, new_h))
                        self.after(0, self.update_ui, ctk_img)
                        
                        self.frames += 1
                        if time.time() - self.fps_start >= 1:
                            self.fps_label.configure(text=f"FPS: {self.frames}")
                            self.frames = 0
                            self.fps_start = time.time()

            except Exception as e:
                print(f"Connection Reset: {e}")
            finally:
                if 'conn' in locals(): conn.close()
                self.status_label.configure(text="WAITING...", text_color="yellow")
                self.feed_label.configure(image=None, text="SIGNAL LOST")

    def recv_bytes(self, sock, count):
        buf = b''
        while len(buf) < count:
            try:
                newbuf = sock.recv(count - len(buf))
                if not newbuf: return None
                buf += newbuf
            except: return None
        return buf

    def update_ui(self, img):
        self.feed_label.configure(image=img)

    def on_close(self):
        self.running = False
        self.destroy()

if __name__ == "__main__":
    app = MetroServer()
    app.protocol("WM_DELETE_WINDOW", app.on_close)
    app.mainloop()