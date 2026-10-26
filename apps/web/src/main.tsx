import React from 'react';
import {createRoot} from 'react-dom/client';
import {SessionApp} from './SessionApp';
import {Inspection} from './Inspection';
const inspection=window.location.hash.startsWith('#/inspection');
createRoot(document.getElementById('root')!).render(<React.StrictMode>{inspection?<div className="inspection-standalone"><a className="back-link" href="http://127.0.0.1:8084/#/dashboard">← Monitoreo real</a><Inspection/></div>:<SessionApp/>}</React.StrictMode>);
