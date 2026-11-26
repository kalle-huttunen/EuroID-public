// First, so antd's static Modal.confirm, message and notification render under React 19.
import './config/antd-react19';
import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
