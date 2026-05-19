#!/usr/bin/env python3
"""
SSH Agent for Biji - Handles SSH connections via paramiko
Direct shell interaction with proper PTY support
"""
import sys
import json
import paramiko
import socket
import threading
import time

class SSHAgent:
    def __init__(self):
        self.client = None
        self.channel = None

    def connect(self, host, port, username, password=None, private_key_path=None, passphrase=None):
        """Connect to SSH server and request shell"""
        try:
            print(json.dumps({"type": "debug", "msg": f"Connecting to {username}@{host}:{port}"}), flush=True)

            self.client = paramiko.SSHClient()
            self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

            # Prepare key
            pkey = None
            if private_key_path:
                try:
                    if passphrase:
                        pkey = paramiko.RSAKey.from_private_key_file(private_key_path, password=passphrase)
                    else:
                        pkey = paramiko.RSAKey.from_private_key_file(private_key_path)
                except:
                    try:
                        if passphrase:
                            pkey = paramiko.Ed25519Key.from_private_key_file(private_key_path, password=passphrase)
                        else:
                            pkey = paramiko.Ed25519Key.from_private_key_file(private_key_path)
                    except:
                        pass

            # Connect
            self.client.connect(
                hostname=host,
                port=int(port),
                username=username,
                password=password,
                pkey=pkey,
                look_for_keys=False,
                allow_agent=False,
                timeout=15,
                disabled_algorithms={'pubkeys': [], 'keys': []}
            )

            print(json.dumps({"type": "debug", "msg": "Connected, requesting shell"}), flush=True)

            # Request interactive shell
            self.channel = self.client.invoke_shell(term='xterm-256color', width=120, height=30)
            self.channel.settimeout(0.0)  # Non-blocking

            print(json.dumps({"type": "connected"}), flush=True)

            # Start read thread
            self._start_read_thread()

        except Exception as e:
            print(json.dumps({"type": "error", "msg": f"Connection failed: {str(e)}"}), flush=True)
            raise

    def _start_read_thread(self):
        """Read from channel in background"""
        def read_loop():
            while self.channel and not self.channel.closed:
                try:
                    # Non-blocking read with small timeout
                    if self.channel.recv_ready():
                        data = self.channel.recv(4096)
                        if data:
                            print(json.dumps({"type": "data", "data": data.decode('utf-8', errors='replace')}), flush=True)
                    else:
                        time.sleep(0.05)
                except socket.timeout:
                    time.sleep(0.05)
                except Exception as e:
                    break

            print(json.dumps({"type": "closed"}), flush=True)

        thread = threading.Thread(target=read_loop, daemon=True)
        thread.start()

    def write(self, data):
        """Write to shell"""
        if self.channel and not self.channel.closed:
            try:
                self.channel.send(data.encode('utf-8'))
            except Exception as e:
                print(json.dumps({"type": "error", "msg": f"Write error: {str(e)}"}), flush=True)

    def resize(self, cols, rows):
        """Resize shell"""
        if self.channel and not self.channel.closed:
            try:
                self.channel.resize_pty(cols, rows)
            except:
                pass

    def close(self):
        """Close connection"""
        try:
            if self.channel:
                self.channel.close()
            if self.client:
                self.client.close()
        except:
            pass

def main():
    agent = SSHAgent()

    try:
        for line in sys.stdin:
            try:
                cmd = json.loads(line.strip())

                if cmd['type'] == 'connect':
                    agent.connect(
                        host=cmd['host'],
                        port=cmd.get('port', 22),
                        username=cmd['username'],
                        password=cmd.get('password'),
                        private_key_path=cmd.get('privateKeyPath'),
                        passphrase=cmd.get('passphrase')
                    )

                elif cmd['type'] == 'write':
                    agent.write(cmd['data'])

                elif cmd['type'] == 'resize':
                    agent.resize(cmd['cols'], cmd['rows'])

                elif cmd['type'] == 'close':
                    agent.close()
                    break

            except json.JSONDecodeError:
                continue
            except Exception as e:
                print(json.dumps({"type": "error", "msg": str(e)}), flush=True)

    except KeyboardInterrupt:
        agent.close()
    except Exception as e:
        print(json.dumps({"type": "error", "msg": f"Fatal: {str(e)}"}), flush=True)
        agent.close()

if __name__ == '__main__':
    main()
