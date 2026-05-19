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

            # Read initial prompt
            import time
            time.sleep(0.3)
            output = self.connection.read_channel()
            if output:
                print(json.dumps({"type": "data", "data": output}), flush=True)

            print(json.dumps({"type": "connected"}), flush=True)

            # Start keep-alive thread
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
        """Monitor connection - keep it alive but don't spam reads"""
        import time

        def keep_alive():
            # Just keep the connection alive without aggressive reading
            # The write() method will trigger reads when needed
            while self.connection and self.connection.is_alive():
                try:
                    time.sleep(1)
                except:
                    break
            print(json.dumps({"type": "closed"}), flush=True)

        self.read_thread = threading.Thread(target=keep_alive, daemon=True)
        self.read_thread.start()

    def write(self, data):
        """Send command to device and read response"""
        if self.connection and self.connection.is_alive():
            try:
                import time
                self.connection.write_channel(data)
                # Wait for device to process
                time.sleep(0.2)
                # Read and send all available output
                while True:
                    try:
                        output = self.connection.read_channel()
                        if output:
                            print(json.dumps({"type": "data", "data": output}), flush=True)
                        else:
                            break  # No more data
                    except:
                        break
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
