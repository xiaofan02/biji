#!/usr/bin/env python3
"""
SSH Agent for Biji - Handles SSH connections via netmiko
Optimized for network devices (Cisco, Juniper, etc.)
Communicates with Electron main process via stdin/stdout
"""
import sys
import json
import threading
from netmiko import ConnectHandler
from netmiko.exceptions import (
    NetmikoAuthenticationException,
    NetmikoTimeoutException,
)

class NetmikoAgent:
    def __init__(self):
        self.connection = None
        self.read_thread = None

    def connect(self, host, port, username, password=None, private_key_path=None, passphrase=None, device_type='cisco_ios'):
        """Connect to network device using netmiko"""
        try:
            print(json.dumps({"type": "debug", "msg": f"Connecting to {username}@{host}:{port} (netmiko)"}), flush=True)

            device = {
                'device_type': device_type,
                'host': host,
                'port': int(port),
                'username': username,
                'password': password or '',
                'secret': '',
                'timeout': 20,
                'conn_timeout': 20,
                'global_delay_factor': 1,
                'use_keys': bool(private_key_path),
                'key_file': private_key_path,
                'passphrase': passphrase,
            }

            self.connection = ConnectHandler(**device)

            print(json.dumps({"type": "debug", "msg": "Connected successfully"}), flush=True)
            print(json.dumps({"type": "connected"}), flush=True)

            # Start reading thread to monitor connection
            self._start_read_thread()

        except NetmikoAuthenticationException as e:
            print(json.dumps({"type": "error", "msg": f"Authentication failed: {str(e)}"}), flush=True)
            raise
        except NetmikoTimeoutException as e:
            print(json.dumps({"type": "error", "msg": f"Connection timeout: {str(e)}"}), flush=True)
            raise
        except Exception as e:
            print(json.dumps({"type": "error", "msg": f"Connection failed: {str(e)}"}), flush=True)
            raise

    def _start_read_thread(self):
        """Monitor connection and send prompts"""
        import time

        def read_loop():
            try:
                # Send initial newline to trigger prompt
                self.connection.write_channel('\n')
                time.sleep(0.5)

                # Get initial prompt
                output = self.connection.read_channel()
                if output:
                    print(json.dumps({"type": "data", "data": output}), flush=True)

                # Keep connection alive and forward unsolicited output with polling
                while self.connection.is_alive():
                    try:
                        # Use a longer sleep to reduce CPU usage and spam
                        time.sleep(0.3)
                        output = self.connection.read_channel()
                        if output and output.strip():  # Only send non-empty output
                            print(json.dumps({"type": "data", "data": output}), flush=True)
                    except Exception as e:
                        # Ignore read errors, connection might be idle
                        time.sleep(0.5)
                        continue

            except Exception as e:
                print(json.dumps({"type": "error", "msg": f"Read error: {str(e)}"}), flush=True)
            finally:
                print(json.dumps({"type": "closed"}), flush=True)

        self.read_thread = threading.Thread(target=read_loop, daemon=True)
        self.read_thread.start()

    def write(self, data):
        """Send command to device"""
        if self.connection and self.connection.is_alive():
            try:
                import time
                self.connection.write_channel(data)
                # Don't immediately read - let the read_loop handle it
                # This prevents blocking and allows proper command execution
                time.sleep(0.05)
            except Exception as e:
                print(json.dumps({"type": "error", "msg": f"Write error: {str(e)}"}), flush=True)

    def close(self):
        """Close connection"""
        try:
            if self.connection:
                self.connection.disconnect()
        except:
            pass

def main():
    agent = NetmikoAgent()

    try:
        for line in sys.stdin:
            try:
                cmd = json.loads(line.strip())

                if cmd['type'] == 'connect':
                    # Auto-detect device type from host or use cisco_ios as default
                    device_type = cmd.get('deviceType', 'cisco_ios')
                    agent.connect(
                        host=cmd['host'],
                        port=cmd.get('port', 22),
                        username=cmd['username'],
                        password=cmd.get('password'),
                        private_key_path=cmd.get('privateKeyPath'),
                        passphrase=cmd.get('passphrase'),
                        device_type=device_type
                    )

                elif cmd['type'] == 'write':
                    agent.write(cmd['data'])

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
