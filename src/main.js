import { createApp } from './app/App.js';
import { initTheme } from './lib/theme.js';

initTheme();
createApp(document.querySelector('#app'));
