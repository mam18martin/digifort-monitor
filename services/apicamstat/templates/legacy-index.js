'use strict';
// Canonical Docker integration lives in Digifort Monitor; no users or servers are embedded here.
const path=require('node:path');
const root=process.env.DIGIFORT_MONITOR_ROOT||path.resolve(__dirname,'../../digifort-monitor');
const implementation=require(path.join(root,'services','apicamstat','index.js'));
if(require.main===module)implementation.main().catch(()=>{console.error('No se pudo iniciar apicamstat; revisar configuración privada.');process.exitCode=1;});
module.exports=implementation;
