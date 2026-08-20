const cron = require('node-cron')

console.log('Cron job started')
fetch('http://localhost:3000/api/cron', {
  method: 'POST'
})

// The abandoned-order inventory release that used to run here was dead code —
// nothing in this app creates an unpaid order. What's left is sales
// activation/deactivation.
cron.schedule('30 * * * *', () => {
  console.log('Running scheduled sale activation/deactivation')
  fetch('http://localhost:3000/api/cron', {
    method: 'POST'
  })
})
