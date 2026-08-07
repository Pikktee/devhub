import http from 'node:http'

// Tut, was Next.js tut: nimmt eine andere Nummer und schreibt eine Zeile ins
// Log, die niemand liest. Der Hub muss das von außen bemerken.
const zugewiesen = Number(process.argv[2])
const tatsaechlich = zugewiesen + 7

http
  .createServer((_req, res) => res.end('ausgewichen'))
  .listen(tatsaechlich, '127.0.0.1', () => {
    console.log(`Port ${zugewiesen} nicht benutzt, stattdessen ${tatsaechlich}`)
  })
