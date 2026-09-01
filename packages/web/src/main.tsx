import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { loadConfig } from './config';
import { IpamAuthProvider } from './auth';
import { App } from './App';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import './styles.css';

// Configuration must be resolved before the auth provider is constructed,
// because the OIDC client is created from it.
void loadConfig().then(() => {
  const container = document.getElementById('root');
  if (!container) throw new Error('Root element not found');

  createRoot(container).render(
    <StrictMode>
      <BrowserRouter>
        <IpamAuthProvider>
          <App />
        </IpamAuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
});
