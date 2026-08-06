const { createRequire } = require('node:module')
const { resolve } = require('node:path')

const appPackage = resolve(process.argv[2] || 'release/win-unpacked/resources/app.asar/package.json')
const appRequire = createRequire(appPackage)
const { SerialPort } = appRequire('serialport')

SerialPort.list()
  .then((ports) => {
    console.log(JSON.stringify({ loaded: true, ports: ports.map((port) => port.path) }))
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
