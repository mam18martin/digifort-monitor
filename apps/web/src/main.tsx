import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
function App() {
 const [state, setState] = useState('Verificando conexión…');
 useEffect(() => { const controller = new AbortController();
   fetch('/api/v1/health', { signal: controller.signal })
    .then(async r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(data => setState(data.status === 'ok' ? 'API conectada' : 'Respuesta inesperada'))
    .catch(e => { if (e.name !== 'AbortError') setState('API no disponible'); });
   return () => controller.abort(); }, []);
 return <main><div className="eyebrow">MUNICIPALIDAD · INFRAESTRUCTURA TECNOLÓGICA</div><h1>Centro de Monitoreo</h1><p>Base de la nueva plataforma de cámaras, nodos y mantenimiento de fibra óptica.</p><section><h2>Estado del sistema</h2><div className="status"><span className="dot"/>{state}</div><small>Primera etapa: infraestructura y conectividad. Los indicadores de cámaras se incorporarán al conectar Digifort.</small></section></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
