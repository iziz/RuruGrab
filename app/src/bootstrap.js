import { renderApp } from './ui/renderApp'

const appRoot = document.querySelector('#app')
if (!appRoot) {
  throw new Error('#app element not found')
}

renderApp(appRoot)
await import('./main.js')
