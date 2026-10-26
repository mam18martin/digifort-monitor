'use strict';
// CameraId, type and legacy fields preserved from the existing apicamstat implementation.
const CAMERA_TYPE_MAP = { F: 'Fija', D: 'Domo', P: 'Punto' };
const DESC_REGEX      = /^(\d{2,4})([FDP])\)/i;
function parseNullable(v){return typeof v==='boolean'?v:typeof v==='string'&&['true','false'].includes(v.toLowerCase())?v.toLowerCase()==='true':null;}
function parseBool(value, defaultValue = false) {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
}
function mapCameras(camerasData,statusData,server,nodes=[]){
 const nodeIndex=new Map(nodes.map(n=>[n.NodoId,n]));
function getNodoByCameraIp(connectionAddress) {
    if (!connectionAddress) return { NodoId: '', NodoName: 'Sin Dirección' };

    const octets = connectionAddress.split('.');
    if (octets.length < 3) return { NodoId: '', NodoName: 'IP Inválida' };

    const thirdOctet = octets[2];
    return nodeIndex.get(thirdOctet) ?? { NodoId: thirdOctet, NodoName: 'Desconocido' };
}
    const statusIndex = new Map(statusData.map(s => [s.Name, s]));
    let matches = 0;

    const cameras = camerasData.map(cam => {
        const status = statusIndex.get(cam.Name) ?? {};
        if (status.Name) matches++;

        const descMatch  = DESC_REGEX.exec((cam.Description || '').trim());
        const cameraId   = descMatch ? descMatch[1] : '';
        const typeLetter = descMatch ? descMatch[2].toUpperCase() : '';
        const nodoInfo   = getNodoByCameraIp(cam.ConnectionAddress);

        return {
            CameraId                  : cameraId,
            CameraType                : CAMERA_TYPE_MAP[typeLetter] ?? '',
            Name                      : cam.Name                 || '',
            Description               : cam.Description          || '',
            Active                    : parseBool(status.Active ?? cam.Active),
            Model                     : cam.Model                || '',
            DeviceType                : cam.DeviceType           || '',
            ConnectionAddress         : cam.ConnectionAddress    || '',
            ConnectionPort            : cam.ConnectionPort       || '',
            Latitude                  : cam.Latitude             || '',
            Longitude                 : cam.Longitude            || '',
            Memo                      : cam.Memo                 || '',
            MediaProfiles             : cam.MediaProfiles        || '',
            Group                     : cam.Group                || '',
            StatusActive              : status.Active==null?null:parseNullable(status.Active),
            StatusWorking             : status.Working==null?null:parseNullable(status.Working),
            StatusCoverage            : status.Name?'matched':'missing',
            Working                   : parseBool(status.Working),
            ActiveTime                : status.ActiveTime        || '',
            InactiveTime              : status.InactiveTime      || '',
            ConfiguredToRecord        : parseBool(status.ConfiguredToRecord),
            WrittingToDisk            : parseBool(status.WrittingToDisk),
            RecordingFPS              : status.RecordingFPS              ?? 0,
            RecordingHours            : status.RecordingHours            ?? 0,
            RecordingHoursEstimative  : status.RecordingHoursEstimative  ?? 0,
            UsedDiskSpace             : status.UsedDiskSpace             ?? 0,
            ServerId                  : server.ServerId,
            ServerName                : server.ServerName,
            ServerIp                  : server.ServerIp,
            NodoName                  : nodoInfo.NodoName,
            NodoId                    : nodoInfo.NodoId
        };
    });


return cameras;
}
module.exports={mapCameras,parseBool};
