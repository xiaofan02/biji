#!/usr/bin/env python3
"""
SSH Agent for Biji - Handles SSH connections via paramiko
Communicates with Electron main process via stdin/stdout
"""
import sys
import json
import paramiko
import socket
import time
import threading
from io import StringIO

class SSHAgent:
    def __init__(self):
        self.client = None
        self.channel = None
        self.lock = threading.Lock()

    def connect(self, host, port, username, password=None, private_key_path=None, passphrase=None):
        """Connect to SSH server"""
        try:
            self.client = paramiko.SSHClient()
            self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

            # Configure to support old algorithms
            transport = paramiko.Transport((host, int(port)))

            # Set algorithms to support old/legacy SSH servers
            transport.get_security_options().kex = [
                'diffie-hellman-group1-sha1',
                'diffie-hellman-group14-sha1',
                'ecdh-sha2-nistp256',
                'ecdh-sha2-nistp384',
                'ecdh-sha2-nistp521'
            ]
            transport.get_security_options().key_types = [
                'ssh-rsa',
                'rsa-sha2-256',
                'rsa-sha2-512'
            ]
            transport.get_security_options().ciphers = [
                '3des-cbc',
                'aes128-cbc',
                'aes128-ctr',
                'aes256-cbc',
                'aes256-ctr'
            ]
            transport.get_security_options().digests = [
                'hmac-sha1',
                'hmac-sha2-256'
            ]

            print(json.dumps({"type": "debug", "msg": f"Connecting to {username}@{host}:{port}"}), flush=True)

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
                look_for_keys=True,
                allow_agent=True,
                timeout=15
            )

            # Request PTY
            self.channel = self.client.invoke_shell(
                term='xterm-256color',
                width=80,
                height=24
            )
            self.channel.settimeout(0.1)

            print(json.dumps({"type": "connected"}), flush=True)

            # Start reading thread
            self._start_read_thread()

        except paramiko.AuthenticationException as e:
            print(json.dumps({"type": "error", "msg": f"Authentication failed: {str(e)}"}), flush=True)
            raise
        except paramiko.SSHException as e:
            print(json.dumps({"type": "error", "msg": f"SSH error: {str(e)}"}), flush=True)
            raise
        except socket.timeout as e:
            print(json.dumps({"type": "error", "msg": f"Connection timeout: {str(e)}"}), flush=True)
            raise
        except Exception as e:
            print(json.dumps({"type": "error", "msg": f"Connection failed: {str(e)}"}), flush=True)
            raise

    def _start_read_thread(self):
        """Start thread to read from channel"""
        def read_loop():
            while self.channel and not self.channel.closed:
                try:
                    data = self.channel.recv(4096)
                    if data:
                        print(json.dumps({"type": "data", "data": data.decode('utf-8', errors='replace')}), flush=True)
                    else:
                        break
                except socket.timeout:
                    continue
                except Exception as e:
                    print(json.dumps({"type": "error", "msg": f"Read error: {str(e)}"}), flush=True)
                    break
            print(json.dumps({"type": "closed"}), flush=True)

        thread = threading.Thread(target=read_loop, daemon=True)
        thread.start()

    def write(self, data):
        """Write to channel"""
        if self.channel and not self.channel.closed:
            try:
                self.channel.sendall(data.encode('utf-8'))
            except Exception as e:
                print(json.dumps({"type": "error", "msg": f"Write error: {str(e)}"}), flush=True)

    def resize(self, cols, rows):
        """Resize PTY"""
        if self.channel and not self.channel.closed:
            try:
                self.channel.resize_pty(cols, rows)
            except Exception as e:
                print(json.dumps({"type": "error", "msg": f"Resize error: {str(e)}"}), flush=True)

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

