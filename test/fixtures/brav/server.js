import http from 'node:http'

const argv = process.argv
const flagIndex = argv.indexOf('--port')
const port = Number(flagIndex >= 0 ? argv[flagIndex + 1] : process.env.PORT)

if (!Number.isInteger(port)) {
  console.error('kein Port übergeben')
  process.exit(1)
}

http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`brav auf ${port}\n`)
  })
  .listen(port, '127.0.0.1', () => console.log(`bereit auf ${port}`))
