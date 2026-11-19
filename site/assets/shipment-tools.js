let labelDecoder;
let labelStream;
let scanVersion = 0;
let scanFrame = 0;

function loadLabelDecoder() {
  labelDecoder ||= new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src=siteAsset('jsQR.js');
    script.onload=()=>typeof window.jsQR==='function' ? resolve(window.jsQR) : reject(new Error('QR scanner unavailable.'));
    script.onerror=()=>reject(new Error('QR scanner unavailable. Enter the tracking number instead.'));
    document.head.append(script);
  }).catch(error=>{labelDecoder=null;throw error;});
  return labelDecoder;
}

function stopLabelCamera() {
  scanVersion++;
  if (scanFrame) cancelAnimationFrame(scanFrame);
  scanFrame=0;
  for (const track of labelStream?.getTracks() || []) track.stop();
  labelStream=null;
  $('label-camera').srcObject=null;
  $('label-camera').hidden=true;
  $('stop-label-camera').hidden=true;
  $('start-label-camera').hidden=false;
}

function labelCode(value) {
  let code=value.trim();
  if (/^https?:\/\//i.test(code)) code=new URL(code).searchParams.get('tracking') || '';
  code=code.toUpperCase();
  if (!/^(PF|GF)-[A-Z0-9-]{1,47}$/.test(code)) throw new Error('Use a GlobeFreight tracking number or tracking link.');
  return code;
}

async function openScannedShipment(value) {
  const active=session;
  const code=labelCode(value);
  async function find(current) {
    const rows=await staffRequest('pf_shipments?select=id&tracking_code=eq.'+encodeURIComponent(current));
    return rows[0]?.id;
  }
  let id=await find(code);
  if (!id && code.startsWith('PF-') && active===session) {
    const old=await rpc('pf_track',{code},false);
    if (old?.tracking_code && active===session) id=await find(old.tracking_code);
  }
  if (active!==session) return;
  if (!id) throw new Error('No shipment you can access matches this tracking number.');
  stopLabelCamera();
  $('label-scanner').open=false;
  await openShipment(id);
  $('shipment-detail').scrollIntoView({block:'start'});
}

function decodeLabelFrame(source,width,height,canvas,decoder) {
  if (!width || !height) return null;
  const scale=Math.min(1,960/Math.max(width,height));
  const w=Math.max(1,Math.round(width*scale));
  const h=Math.max(1,Math.round(height*scale));
  canvas.width=w;
  canvas.height=h;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(source,0,0,w,h);
  return decoder(ctx.getImageData(0,0,w,h).data,w,h)?.data || null;
}

$('start-label-camera').onclick = event=>run(event.currentTarget,async()=>{
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Live camera is unavailable. Upload a label photo or enter the number.');
  const version=++scanVersion;
  const decoder=await loadLabelDecoder();
  if (version!==scanVersion) return;
  const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
  if (version!==scanVersion || !$('label-scanner').open) {
    stream.getTracks().forEach(track=>track.stop());
    return;
  }
  labelStream=stream;
  const video=$('label-camera');
  video.srcObject=stream;
  video.hidden=false;
  $('start-label-camera').hidden=true;
  $('stop-label-camera').hidden=false;
  try { await video.play(); } catch(error) { stopLabelCamera(); throw error; }
  if (version!==scanVersion) return;
  const canvas=el('canvas');
  let last=0;
  function scan(now) {
    if (version!==scanVersion) return;
    if (now-last>180 && video.readyState>=2) {
      last=now;
      let match;
      try { match=decodeLabelFrame(video,video.videoWidth,video.videoHeight,canvas,decoder); }
      catch { stopLabelCamera();message($('label-scan-message'),'Could not read the camera frame.',true);return; }
      if (match) {
        stopLabelCamera();
        openScannedShipment(match).catch(error=>message($('label-scan-message'),error.message,true));
        return;
      }
    }
    scanFrame=requestAnimationFrame(scan);
  }
  scanFrame=requestAnimationFrame(scan);
},$('label-scan-message'));

$('stop-label-camera').onclick=stopLabelCamera;
$('label-scanner').addEventListener('toggle',()=>{if (!$('label-scanner').open) stopLabelCamera();});
document.addEventListener('visibilitychange',()=>{if (document.hidden) stopLabelCamera();});
window.addEventListener('pagehide',stopLabelCamera);

$('label-upload').addEventListener('change',async event=>{
  const active=session;
  const upload=event.currentTarget;
  const file=upload.files[0];
  if (!file || !active) return;
  message($('label-scan-message'));
  upload.disabled=true;
  let image;
  try {
    if (file.size>8*1024*1024) throw new Error('Choose a label photo under 8 MB.');
    const decoder=await loadLabelDecoder();
    image=await createImageBitmap(file);
    if (session!==active || !$('label-scanner').open) return;
    const value=decodeLabelFrame(image,image.width,image.height,el('canvas'),decoder);
    if (!value) throw new Error('No readable QR code was found in the photo.');
    await openScannedShipment(value);
  } catch(error) {
    message($('label-scan-message'),error.message,true);
  } finally {
    image?.close();
    upload.value='';
    upload.disabled=false;
  }
});

bind($('label-scan-form'),values=>openScannedShipment(values.get('label')),$('label-scan-message'));

function reportCell(value) {
  const text=String(value??'');
  const safe=/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text) ? "'"+text : text;
  return '"'+safe.replaceAll('"','""')+'"';
}

const reportColumns=[
  ['Tracking number','tracking_code'],['Origin','origin'],['Destination','destination'],['Service','service'],
  ['Estimated delivery','eta'],['Created (UTC)','created_at'],['Latest status','status'],['Latest update (UTC)','latest_update']
];

function reportCsv(rows) {
  return [reportColumns.map(([label])=>reportCell(label)).join(','),
    ...rows.map(row=>reportColumns.map(([,key])=>reportCell(row[key])).join(','))].join('\r\n')+'\r\n';
}

bind($('shipment-report-form'),async values=>{
  const filters=Object.fromEntries(values);
  if (filters.to<filters.from) throw new Error('The end date must be on or after the start date.');
  const active=session;
  const rows=await rpc('gf_shipment_report',{filters});
  if (active!==session || !isAdmin) return;
  if (rows.length>5000) throw new Error('More than 5,000 shipments match. Choose a shorter date range or another filter.');
  if (!rows.length) {message($('shipment-report-message'),'No shipments matched these filters.');return;}
  const url=URL.createObjectURL(new Blob(['\ufeff',reportCsv(rows)],{type:'text/csv;charset=utf-8'}));
  const anchor=el('a');
  anchor.href=url;
  anchor.download='globefreight-shipments-'+filters.from+'-to-'+filters.to+'.csv';
  anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
  message($('shipment-report-message'),rows.length+' shipments exported.');
},$('shipment-report-message'));

const todayUtc=new Date().toISOString().slice(0,10);
$('report-start').value=todayUtc.slice(0,8)+'01';
$('report-end').value=todayUtc;
$('report-service').replaceChildren(new Option('All services',''),...services.map(value=>new Option(value,value)));
$('report-status').replaceChildren(new Option('All statuses',''),...statuses.map(value=>new Option(value,value)));
