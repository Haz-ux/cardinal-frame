import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { applyDetectedViewport } from './viewportMode';

// Pre-auth screens (login + splash) follow the browser's detected mode; the
// authenticated shell re-applies the user's manual toggle in Layout.
applyDetectedViewport();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
