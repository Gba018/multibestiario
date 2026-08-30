/* ===== CONFIG ===== */
var CLOUDINARY_CLOUD_NAME = 'rdhjpcli';
var CLOUDINARY_UPLOAD_PRESET = 'multibestiario';
var SUPABASE_URL = 'https://qdhqdmurypaiktehnwjr.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_tj3GLsRnyoZd1G15h7bTyg_P6b05xxg';
var supabaseClient = null;
var cloudUser = null;
var cloudSyncTimer = null;
var cloudSyncReady = false;
var cloudSyncInProgress = false;
var isPublicView = false;

/* ===== STATE ===== */
var data = JSON.parse(localStorage.getItem('multibestiario_v3')) || { series: [], allTags: [], folders: [], apiConfigs: {} };
if (!data.folders) data.folders = [];
if (!data.apiConfigs) data.apiConfigs = {};
var pokeCache = JSON.parse(localStorage.getItem('pokeCache')) || {};
var currentModal = null;
var currentSeriesId = null;
var currentCharId = null;
var currentItemId = null;
var currentFolderId = null;
var tempImageUrl = null;
var tempCoverUrl = null;
var homeFilter = 'all';
var homeSearchQuery = '';
var isImporting = false;
var homeFiltersExpanded = false;
var apiPreviewData = null;
var apiImporting = false;
var apiConfigRestored = false;
var styleEditorSelected = 0;
var styleEditorSelectionType = 'block';
var styleEditorDragging = null;
var styleEditorDraft = null;
var storageWarningShown = false;
var API_PRESETS = {
  digimon: {
    label: 'Digimon API', url: 'https://digi-api.com/api/v1/digimon?page=1&pageSize=50', collection: 'content', name: 'name', image: 'image', tags: '',
    mappings: [{ source: 'id', label: 'ID', type: 'number' }, { source: 'href', label: 'Ficha API', type: 'url' }]
  }
};

// Las listas son extensibles: cada una mantiene su propia configuración de campos.
data.series.forEach(function(s) {
  if (!s.fields) s.fields = [];
  if (!s.tags) s.tags = [];
  if (!s.characters) s.characters = [];
  (s.characters || []).forEach(function(c) {
    if (!c.values) c.values = {};
    if (!c.images) c.images = c.image ? [c.image] : [];
    if (!c.image && c.images.length) c.image = c.images[0];
  });
});

/* ===== POKEAPI RANGES ===== */
var POKEAPI_RANGES = {
  gen1:     { name: 'Pokemon - Gen I (Kanto)',    offset: 0,   limit: 151 },
  gen2:     { name: 'Pokemon - Gen II (Johto)',   offset: 151, limit: 100 },
  gen3:     { name: 'Pokemon - Gen III (Hoenn)',  offset: 251, limit: 135 },
  gen4:     { name: 'Pokemon - Gen IV (Sinnoh)',  offset: 386, limit: 107 },
  gen5:     { name: 'Pokemon - Gen V (Unova)',    offset: 493, limit: 156 },
  gen6:     { name: 'Pokemon - Gen VI (Kalos)',   offset: 649, limit: 72  },
  gen7:     { name: 'Pokemon - Gen VII (Alola)',  offset: 721, limit: 88  },
  gen8:     { name: 'Pokemon - Gen VIII (Galar)', offset: 809, limit: 96  },
  gen9:     { name: 'Pokemon - Gen IX (Paldea)',   offset: 905, limit: 120 },
  national: { name: 'Pokemon - Pokedex Nacional', offset: 0,   limit: 1025 }
};

/* ===== HELPERS ===== */
function saveData() {
  var serialized = JSON.stringify(data);
  try {
    localStorage.setItem('multibestiario_v3', serialized);
    scheduleCloudSave();
    return true;
  } catch (error) {
    // Las imágenes en base64 y respuestas muy grandes pueden superar la cuota.
    // Conservamos la información y eliminamos únicamente copias pesadas de imágenes.
    var compactData = JSON.parse(JSON.stringify(data, function(key, value) {
      if (typeof value === 'string' && value.indexOf('data:image/') === 0) return '';
      return value;
    }));
    try {
      localStorage.setItem('multibestiario_v3', JSON.stringify(compactData));
      data = compactData;
      scheduleCloudSave();
      if (!storageWarningShown) {
        storageWarningShown = true;
        alert('El almacenamiento estaba lleno. Se guardaron los datos sin imágenes locales demasiado grandes.');
      }
      return true;
    } catch (compactError) {
      // La cache de la API es regenerable y puede ser la responsable de ocupar
      // la cuota completa; se elimina solo como último recurso.
      try {
        localStorage.removeItem('pokeCache');
        pokeCache = {};
        localStorage.setItem('multibestiario_v3', JSON.stringify(compactData));
        data = compactData;
        scheduleCloudSave();
        if (!storageWarningShown) {
          storageWarningShown = true;
          alert('Se liberó la cache antigua de la API para poder guardar tus listas.');
        }
        return true;
      } catch (finalError) {
      if (!storageWarningShown) {
        storageWarningShown = true;
        alert('No hay espacio suficiente para guardar MultiBestiario. Exporta tus datos y elimina listas o imágenes grandes.');
      }
      console.error('No se pudo guardar MultiBestiario:', finalError);
      return false;
      }
    }
  }
}

function scheduleCloudSave() {
  if (!cloudSyncReady || !cloudUser || !supabaseClient) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(saveDataToCloud, 700);
}

async function saveDataToCloud() {
  if (cloudSyncInProgress || !cloudSyncReady || !cloudUser) return;
  cloudSyncInProgress = true;
  var result = await supabaseClient.from('user_data').upsert({ user_id: cloudUser.id, data: data, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  cloudSyncInProgress = false;
  if (result.error) console.error('No se pudo sincronizar con Supabase:', result.error.message);
  if (!result.error) {
    var shares = await supabaseClient.from('public_shares').select('id,entity_type,entity_id').eq('owner_id', cloudUser.id).eq('is_public', true);
    if (!shares.error && shares.data) shares.data.forEach(function(share) {
      var snapshot = publicSnapshot(share.entity_type, share.entity_id);
      if (snapshot) supabaseClient.from('public_shares').update({ snapshot: snapshot, updated_at: new Date().toISOString() }).eq('id', share.id);
    });
  }
}

function publicSnapshot(type, id) {
  if (type === 'list') {
    var list = data.series.find(function(item) { return item.id === id; });
    if (!list) return null;
    list = JSON.parse(JSON.stringify(list));
    list.folderId = null;
    return { series: [list], folders: [], allTags: list.tags || [] };
  }
  var folderIds = [id];
  data.folders.forEach(function(folder) { if (isDescendantOf(folder.id, id)) folderIds.push(folder.id); });
  return { series: data.series.filter(function(list) { return folderIds.indexOf(list.folderId) !== -1; }).map(function(list) { var copy = JSON.parse(JSON.stringify(list)); copy.folderId = null; return copy; }), folders: [], allTags: [] };
}

async function togglePublicShare(type, id) {
  if (!cloudUser || !supabaseClient) return alert('Inicia sesión para publicar contenido.');
  var existing = await supabaseClient.from('public_shares').select('id,share_token,is_public').eq('owner_id', cloudUser.id).eq('entity_type', type).eq('entity_id', id).maybeSingle();
  if (existing.error) return alert('Primero ejecuta el SQL de publicación en Supabase.');
  if (existing.data && existing.data.is_public) {
    await supabaseClient.from('public_shares').update({ is_public: false }).eq('id', existing.data.id);
    alert('Contenido retirado de publicación.');
    return;
  }
  var snapshot = publicSnapshot(type, id);
  if (!snapshot) return;
  var token = existing.data ? existing.data.share_token : generateId() + generateId();
  var payload = { owner_id: cloudUser.id, entity_type: type, entity_id: id, share_token: token, snapshot: snapshot, is_public: true, updated_at: new Date().toISOString() };
  if (existing.data) payload.id = existing.data.id;
  var result = await supabaseClient.from('public_shares').upsert(payload, { onConflict: 'owner_id,entity_type,entity_id' });
  if (result.error) return alert('No se pudo publicar: ' + result.error.message);
  var shareUrl = window.location.origin + window.location.pathname + '?public=' + encodeURIComponent(token);
  if (navigator.clipboard) navigator.clipboard.writeText(shareUrl).catch(function() {});
  prompt('Enlace público (también se copió si el navegador lo permite):', shareUrl);
}

async function loadPublicShare() {
  var token = new URLSearchParams(window.location.search).get('public');
  if (!token || !supabaseClient) return false;
  var result = await supabaseClient.from('public_shares').select('snapshot').eq('share_token', token).eq('is_public', true).maybeSingle();
  if (result.error || !result.data) return false;
  data = result.data.snapshot;
  if (!data.folders) data.folders = [];
  if (!data.allTags) data.allTags = [];
  if (!data.apiConfigs) data.apiConfigs = {};
  (data.series || []).forEach(function(list) { if (!list.tags) list.tags = []; if (!list.fields) list.fields = []; if (!list.characters) list.characters = []; });
  isPublicView = true;
  document.body.classList.add('public-view');
  hideCloudAuth();
  renderHome();
  return true;
}

async function loadDataFromCloud(user) {
  var result = await supabaseClient.from('user_data').select('data').eq('user_id', user.id).maybeSingle();
  if (result.error) throw result.error;
  if (result.data && result.data.data) {
    data = result.data.data;
    if (!data.folders) data.folders = [];
    if (!data.allTags) data.allTags = [];
    if (!data.apiConfigs) data.apiConfigs = {};
    (data.series || []).forEach(function(list) {
      if (!list.fields) list.fields = [];
      if (!list.tags) list.tags = [];
      if (!list.characters) list.characters = [];
      (list.characters || []).forEach(function(item) {
        if (!item.values) item.values = {};
        if (!item.images) item.images = item.image ? [item.image] : [];
        if (!item.image && item.images.length) item.image = item.images[0];
      });
    });
    localStorage.setItem('multibestiario_v3', JSON.stringify(data));
  } else if (data.series.length || data.folders.length) {
    await saveDataToCloud();
  }
}

function hideCloudAuth() {
  var overlay = document.getElementById('cloudAuthOverlay');
  if (overlay) overlay.classList.add('hidden');
}

async function connectCloudUser(user) {
  cloudUser = user;
  cloudSyncReady = true;
  try {
    await loadDataFromCloud(user);
    hideCloudAuth();
    renderHome();
  } catch (error) {
    cloudSyncReady = false;
    document.getElementById('cloudAuthMessage').textContent = 'No se pudo cargar la nube. Ejecuta primero el SQL de configuración de Supabase.';
    console.error('Error de sincronización:', error);
  }
}

function initCloudSync() {
  if (!window.supabase) return;
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var form = document.getElementById('cloudAuthForm');
  form.addEventListener('submit', async function(event) {
    event.preventDefault();
    var message = document.getElementById('cloudAuthMessage');
    message.textContent = 'Conectando...';
    var result = await supabaseClient.auth.signInWithPassword({ email: document.getElementById('cloudAuthEmail').value.trim(), password: document.getElementById('cloudAuthPassword').value });
    if (result.error) {
      console.error('Supabase login:', result.error);
      message.textContent = result.error.status === 401 ? 'Supabase rechazó la clave pública o las credenciales. Recarga la aplicación y verifica la URL y la clave anon.' : 'No se pudo iniciar sesión: ' + result.error.message;
    }
    else await connectCloudUser(result.data.user);
  });
  document.getElementById('cloudAuthRegister').addEventListener('click', async function() {
    var message = document.getElementById('cloudAuthMessage');
    var email = document.getElementById('cloudAuthEmail').value.trim();
    var password = document.getElementById('cloudAuthPassword').value;
    if (!email || !password) {
      message.textContent = 'Escribe un correo y una contraseña para registrarte.';
      return;
    }
    if (password.length < 6) {
      message.textContent = 'La contraseña debe tener al menos 6 caracteres.';
      return;
    }
    message.textContent = 'Creando cuenta...';
    var signupOptions = {};
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      signupOptions.emailRedirectTo = window.location.origin + window.location.pathname;
    }
    var result = await supabaseClient.auth.signUp({ email: email, password: password, options: signupOptions });
    if (result.error) {
      console.error('Supabase registro:', result.error);
      message.textContent = result.error.status === 429 ? 'Supabase alcanzó el límite de correos. Espera unos minutos y revisa tu bandeja antes de volver a registrarte.' : result.error.status === 401 ? 'Supabase rechazó la clave pública. Copia nuevamente la clave anon desde Project Settings → API.' : 'No se pudo crear la cuenta: ' + result.error.message;
    } else if (result.data.session) {
      await connectCloudUser(result.data.user);
    } else {
      message.textContent = 'Cuenta creada. Revisa tu correo para confirmar la cuenta y luego inicia sesión.';
    }
  });
  document.getElementById('cloudAuthContinue').addEventListener('click', hideCloudAuth);
  supabaseClient.auth.onAuthStateChange(function(event, session) {
    if (event === 'SIGNED_IN' && session && !cloudUser) connectCloudUser(session.user);
  });
  var hashParams = new URLSearchParams(window.location.hash.substring(1));
  if (hashParams.get('error')) {
    var hashError = hashParams.get('error_description') || hashParams.get('error');
    document.getElementById('cloudAuthMessage').textContent = 'No se pudo confirmar el correo: ' + hashError.replace(/\+/g, ' ');
  }
  loadPublicShare().then(function(isLoaded) {
    if (isLoaded) return;
    supabaseClient.auth.getSession().then(function(result) {
      if (result.data.session) connectCloudUser(result.data.session.user);
    });
  });
}

function savePokeCache() {
  localStorage.setItem('pokeCache', JSON.stringify(pokeCache));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function getAllTags() {
  var tags = new Set(data.allTags);
  data.series.forEach(function(s) { s.tags.forEach(function(t) { tags.add(t); }); });
  data.series.forEach(function(s) {
    s.characters.forEach(function(c) { c.tags.forEach(function(t) { tags.add(t); }); });
  });
  return Array.from(tags).sort();
}

function addToAllTags(tag) {
  if (data.allTags.indexOf(tag) === -1) {
    data.allTags.push(tag);
    saveData();
  }
}

function esc(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sanitizePublicId(text) {
  return text
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 100);
}

/* ===== SIDEBAR ===== */
function openSidebar() {
  document.getElementById('sidebar').classList.add('active');
  document.getElementById('sidebarOverlay').classList.add('active');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('active');
  document.getElementById('sidebarOverlay').classList.remove('active');
}

/* ===== NAVIGATION ===== */
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById(pageId).classList.add('active');
  document.body.classList.toggle('item-mode', pageId === 'pageItem' || pageId === 'pageStyleEditor');
  window.scrollTo(0, 0);
}

function goHome(folderId) {
  currentSeriesId = null;
  currentCharId = null;
  currentItemId = null;
  styleEditorDraft = null;
  currentFolderId = folderId || null;
  renderHome();
  showPage('pageHome');
}

function goToSerie(seriesId) {
  currentSeriesId = seriesId;
  currentCharId = null;
  currentItemId = null;
  styleEditorDraft = null;
  renderSerieDetail(seriesId);
  showPage('pageSerie');
}

function goToItem(seriesId, itemId) {
  currentSeriesId = seriesId;
  currentItemId = itemId;
  renderItemDetail(seriesId, itemId);
  showPage('pageItem');
}

function defaultListLayout(s) {
  var blocks = [{ type: 'image', field: 'image', size: 'large' }];
  (s.fields || []).forEach(function(field) { blocks.push({ type: 'text', field: field.id, size: 'medium' }); });
  if (!blocks.some(function(block) { return block.field === 'description'; })) blocks.push({ type: 'text', field: 'alias', size: 'small' });
  return { columns: 2, rows: 1, blocks: blocks };
}

// Recoloca los bloques en orden, buscando siempre la primera zona libre.
// De esta forma cambiar la cantidad de columnas no deja huecos de la grilla anterior.
function reflowLayout(layout) {
  var columns = Math.max(1, Number(layout.columns) || 1);
  var occupied = {};
  var lastRow = 1;
  function isFree(row, col, width, height) {
    for (var y = row; y < row + height; y++) {
      for (var x = col; x < col + width; x++) {
        if (x > columns || occupied[y + ':' + x]) return false;
      }
    }
    return true;
  }
  function reserve(row, col, width, height) {
    for (var y = row; y < row + height; y++) {
      for (var x = col; x < col + width; x++) occupied[y + ':' + x] = true;
    }
    lastRow = Math.max(lastRow, row + height - 1);
  }
  (layout.blocks || []).forEach(function(block) {
    var width = Math.max(0.5, Math.min(Number(block.colSpan || block.span || (block.size === 'large' ? columns : 1)) || 1, columns));
    var height = Math.max(0.5, Number(block.rowSpan) || 1);
    var row = 1;
    var col = 1;
    while (!isFree(row, col, width, height)) {
      col += 0.5;
      if (col + width - 1 > columns) { col = 1; row += 0.5; }
    }
    block.col = col;
    block.row = row;
    block.colSpan = width;
    block.rowSpan = height;
    reserve(row, col, width, height);
  });
  layout.rows = Math.max(Number(layout.rows) || 1, lastRow);
  return layout;
}

function blocksOverlap(a, b) {
  var aLeft = ((Number(a.col) || 1) - 1) * 2;
  var aTop = ((Number(a.row) || 1) - 1) * 2;
  var aRight = aLeft + (Number(a.colSpan) || 1) * 2;
  var aBottom = aTop + (Number(a.rowSpan) || 1) * 2;
  var bLeft = ((Number(b.col) || 1) - 1) * 2;
  var bTop = ((Number(b.row) || 1) - 1) * 2;
  var bRight = bLeft + (Number(b.colSpan) || 1) * 2;
  var bBottom = bTop + (Number(b.rowSpan) || 1) * 2;
  return aLeft < bRight && aRight > bLeft && aTop < bBottom && aBottom > bTop;
}

// Conserva la posición solicitada por un campo y desplaza los que chocan.
function resolveLayoutCollisions(layout, priorityIndex) {
  var columns = Math.max(1, Number(layout.columns) || 1);
  var blocks = layout.blocks || [];
  var priority = blocks[priorityIndex];
  if (!priority) return layout;
  priority.col = Math.max(1, Number(priority.col) || 1);
  priority.row = Math.max(1, Number(priority.row) || 1);
  // Si el campo se mueve más allá del ancho actual, la grilla crece con él.
  columns = Math.max(columns, priority.col + (Number(priority.colSpan) || 1) - 1);
  layout.columns = columns;
  priority.col = Math.min(priority.col, columns);
  priority.colSpan = Math.max(0.5, Math.min(Number(priority.colSpan) || 1, columns - priority.col + 1));
  priority.rowSpan = Math.max(0.5, Number(priority.rowSpan) || 1);
  var placed = [priority];
  function firstFree(block) {
    var row = 1;
    while (row < 1000) {
      for (var col = 1; col <= columns; col += 0.5) {
        if (col + block.colSpan - 1 > columns) break;
        var candidate = { col: col, row: row, colSpan: block.colSpan, rowSpan: block.rowSpan };
        if (!placed.some(function(other) { return blocksOverlap(candidate, other); })) return candidate;
      }
      row += 0.5;
    }
    return { col: 1, row: row, colSpan: block.colSpan, rowSpan: block.rowSpan };
  }
  blocks.forEach(function(block, index) {
    if (index === priorityIndex) return;
    block.colSpan = Math.max(0.5, Math.min(Number(block.colSpan || block.span || 1), columns));
    block.rowSpan = Math.max(0.5, Number(block.rowSpan) || 1);
    var collides = placed.some(function(other) { return blocksOverlap(block, other); });
    if (collides) {
      var free = firstFree(block);
      block.col = free.col;
      block.row = free.row;
    }
    placed.push(block);
  });
  layout.rows = Math.max(1, blocks.reduce(function(max, block) {
    return Math.max(max, (Number(block.row) || 1) + (Number(block.rowSpan) || 1) - 1);
  }, 1));
  return layout;
}

function getListLayout(s) {
  if (!s.layout || !Array.isArray(s.layout.blocks)) s.layout = defaultListLayout(s);
  if (!s.layout.columns) s.layout.columns = 2;
  if (!s.layout.rows) s.layout.rows = 1;
  s.layout.blocks.forEach(function(block, index) {
    if (!block.col) block.col = (index % s.layout.columns) + 1;
    if (!block.row) block.row = Math.floor(index / s.layout.columns) + 1;
    if (!block.colSpan) block.colSpan = block.span || (block.size === 'large' ? s.layout.columns : 1);
    if (!block.rowSpan) block.rowSpan = 1;
  });
  var requiredRows = s.layout.blocks.reduce(function(max, block) {
    return Math.max(max, (block.row || 1) + (block.rowSpan || 1) - 1);
  }, 1);
  s.layout.rows = Math.max(s.layout.rows, requiredRows);
  normalizeFreeLayout(s.layout);
  return s.layout;
}

function normalizeFreeLayout(layout) {
  if (!layout) return layout;
  if (layout.freePositioning) {
    (layout.blocks || []).forEach(function(block) {
      if (block.x === undefined) block.x = 0;
      if (block.y === undefined) block.y = 0;
      if (block.width === undefined) block.width = 30;
      if (block.height === undefined) block.height = 18;
    });
    return layout;
  }
  var columns = Math.max(1, Number(layout.columns) || 2);
  var rows = Math.max(1, Number(layout.rows) || 1);
  (layout.blocks || []).forEach(function(block) {
    block.x = ((Number(block.col) || 1) - 1) / columns * 100;
    block.y = ((Number(block.row) || 1) - 1) / rows * 100;
    block.width = (Number(block.colSpan) || 1) / columns * 100;
    block.height = (Number(block.rowSpan) || 1) / rows * 100;
  });
  layout.canvasHeight = layout.canvasHeight || 640;
  layout.freePositioning = true;
  return layout;
}

/* ===== FOLDERS ===== */
function getFolder(id) {
  return data.folders.find(function(f) { return f.id === id; }) || null;
}

function ensureFolder(name, parentId) {
  parentId = parentId || null;
  var existing = data.folders.find(function(f) {
    return f.name.toLowerCase() === name.toLowerCase() && (f.parentId || null) === parentId;
  });
  if (existing) return existing;
  var folder = { id: generateId(), name: name, parentId: parentId };
  data.folders.push(folder);
  saveData();
  return folder;
}

function getFolderPath(id) {
  var path = [];
  var f = getFolder(id);
  var guard = 0;
  while (f && guard < 50) {
    path.unshift(f);
    f = f.parentId ? getFolder(f.parentId) : null;
    guard++;
  }
  return path;
}

function isDescendantOf(folderId, ancestorId) {
  var f = getFolder(folderId);
  var guard = 0;
  while (f && f.parentId && guard < 50) {
    if (f.parentId === ancestorId) return true;
    f = getFolder(f.parentId);
    guard++;
  }
  return false;
}

function folderOptionsHtml(selectedId, excludeId) {
  var html = '<option value="">Sin carpeta (inicio)</option>';
  function walk(parentId, depth) {
    data.folders.filter(function(f) { return (f.parentId || null) === parentId; }).forEach(function(f) {
      if (excludeId && (f.id === excludeId || isDescendantOf(f.id, excludeId))) return;
      var prefix = '';
      for (var i = 0; i < depth; i++) prefix += '— ';
      html += '<option value="' + f.id + '"' + (selectedId === f.id ? ' selected' : '') + '>' + prefix + esc(f.name) + '</option>';
      walk(f.id, depth + 1);
    });
  }
  walk(null, 0);
  return html;
}

function createFolder() {
  var name = prompt('Nombre de la carpeta (Ej: Pokemon, Anime, Videojuegos...):');
  if (name === null) return;
  name = name.trim();
  if (!name) return;
  ensureFolder(name, currentFolderId);
  saveData();
  renderHome();
}

function renameFolder(id) {
  var f = getFolder(id);
  if (!f) return;
  var name = prompt('Nuevo nombre de la carpeta:', f.name);
  if (name === null) return;
  name = name.trim();
  if (!name) return;
  f.name = name;
  saveData();
  renderHome();
}

function deleteFolder(id) {
  var f = getFolder(id);
  if (!f) return;
  if (!confirm('Eliminar la carpeta "' + f.name + '"? Sus series y subcarpetas subiran un nivel.')) return;
  var parent = f.parentId || null;
  data.series.forEach(function(s) { if (s.folderId === id) s.folderId = parent; });
  data.folders.forEach(function(x) { if (x.parentId === id) x.parentId = parent; });
  data.folders = data.folders.filter(function(x) { return x.id !== id; });
  if (currentFolderId === id) currentFolderId = parent;
  saveData();
  renderHome();
}

function openFolder(id) {
  currentFolderId = id;
  renderHome();
}

/* ===== HOME ===== */
function setHomeFilter(tag) {
  homeFilter = tag;
  renderHome();
}

function renderHomeFilters() {
  var bar = document.getElementById('homeFilterBar');
  var allTags = getAllTags();
  var html = '<span class="filter-label">Filtros:</span>';
  html += '<span class="filter-tag ' + (homeFilter === 'all' ? 'active' : '') + '" data-tag="all">Todos</span>';
  var visibleTags = homeFiltersExpanded ? allTags : allTags.slice(0, 4);
  visibleTags.forEach(function(t) {
    html += '<span class="filter-tag ' + (homeFilter === t ? 'active' : '') + '" data-tag="' + esc(t) + '">' + esc(t) + '</span>';
  });
  if (allTags.length > 4) {
    html += '<button class="filter-expand" id="btnExpandFilters" aria-label="' + (homeFiltersExpanded ? 'Ocultar filtros' : 'Mostrar más filtros') + '" title="' + (homeFiltersExpanded ? 'Ocultar filtros' : 'Mostrar más filtros') + '">' + (homeFiltersExpanded ? '‹' : '&gt;') + '</button>';
  }
  bar.innerHTML = html;
  bar.querySelectorAll('.filter-tag').forEach(function(el) {
    el.addEventListener('click', function() { setHomeFilter(this.dataset.tag); });
  });
  var expandBtn = document.getElementById('btnExpandFilters');
  if (expandBtn) expandBtn.addEventListener('click', function() {
    homeFiltersExpanded = !homeFiltersExpanded;
    renderHomeFilters();
  });
}

function renderHome() {
  renderHomeFilters();
  var grid = document.getElementById('seriesGrid');
  var empty = document.getElementById('homeEmpty');
  var info = document.getElementById('homeResultsInfo');
  var folderBar = document.getElementById('folderBar');

  homeSearchQuery = document.getElementById('homeSearch').value.trim().toLowerCase();
  var isSearching = homeSearchQuery !== '' || homeFilter !== 'all';

  if (currentFolderId && !getFolder(currentFolderId)) currentFolderId = null;

  var filtered = data.series.filter(function(s) {
    var q = homeSearchQuery;
    var matchSearch = !q ||
      s.name.toLowerCase().includes(q) ||
      s.tags.some(function(t) { return t.toLowerCase().includes(q); });
    var matchTag = homeFilter === 'all' || s.tags.indexOf(homeFilter) !== -1;
    return matchSearch && matchTag;
  });

  var foldersToShow = [];
  if (!isSearching) {
    filtered = filtered.filter(function(s) { return (s.folderId || null) === currentFolderId; });
    foldersToShow = data.folders.filter(function(f) { return (f.parentId || null) === currentFolderId; });
  }

  if (!isSearching && currentFolderId) {
    var fo = getFolder(currentFolderId);
    var pathNames = getFolderPath(currentFolderId).map(function(f) { return esc(f.name); }).join(' / ');
    folderBar.style.display = 'flex';
    folderBar.innerHTML =
      '<button class="btn btn-ghost btn-sm" id="btnFolderBack">&#8592;</button>' +
      '<span class="folder-bar-name">&#128193; ' + pathNames + '</span>';
    document.getElementById('btnFolderBack').addEventListener('click', function() { goHome(fo.parentId || null); });
  } else {
    folderBar.style.display = 'none';
    folderBar.innerHTML = '';
  }

  var infoText = filtered.length + ' serie' + (filtered.length !== 1 ? 's' : '');
  if (foldersToShow.length) infoText += ' · ' + foldersToShow.length + ' carpeta' + (foldersToShow.length !== 1 ? 's' : '');
  info.textContent = infoText;

  if (filtered.length === 0 && foldersToShow.length === 0) {
    grid.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  grid.style.display = 'grid';
  empty.style.display = 'none';

  var html = '';

  foldersToShow.forEach(function(f) {
    var fSeries = data.series.filter(function(s) { return s.folderId === f.id; });
    var fSubs = data.folders.filter(function(x) { return x.parentId === f.id; }).length;
    var fCover = '';
    for (var i = 0; i < fSeries.length; i++) {
      if (fSeries[i].cover) { fCover = fSeries[i].cover; break; }
    }
    html += '<div class="series-tile" data-fid="' + f.id + '">';
    html += '<img src="' + (fCover || 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22300%22%20height%3D%22400%22%3E%3Crect%20fill%3D%22%23242424%22%20width%3D%22300%22%20height%3D%22400%22%2F%3E%3C%2Fsvg%3E') + '" class="series-tile-cover" alt="' + esc(f.name) + '">';
    html += '<div class="folder-badge">&#128193; Carpeta</div>';
    html += '<div class="series-tile-actions">';
    html += '<div class="series-tile-action" data-action="edit-folder" data-fid="' + f.id + '">&#9998;</div>';
    html += '<div class="series-tile-action" data-action="public-folder" data-fid="' + f.id + '" title="Publicar carpeta">&#128279;</div>';
    html += '<div class="series-tile-action" data-action="move-folder" data-fid="' + f.id + '">&#8644;</div>';
    html += '<div class="series-tile-action" data-action="del-folder" data-fid="' + f.id + '">&#128465;</div>';
    html += '</div>';
    html += '<div class="series-tile-info">';
    html += '<div class="series-tile-name">' + esc(f.name) + '</div>';
    html += '<div class="series-tile-meta"><span>' + fSeries.length + ' serie' + (fSeries.length !== 1 ? 's' : '') + (fSubs ? ' · ' + fSubs + ' carpeta' + (fSubs !== 1 ? 's' : '') : '') + '</span></div>';
    html += '</div></div>';
  });

  filtered.forEach(function(s) {
    var charCount = s.characters ? s.characters.length : 0;
    var checkedCount = s.characters ? s.characters.filter(function(c) { return c.checked; }).length : 0;
    var cover = s.cover || '';
    var tagsHtml = '';
    s.tags.slice(0, 3).forEach(function(t) {
      tagsHtml += '<span class="series-tile-tag">' + esc(t) + '</span>';
    });
    if (s.tags.length > 3) {
      tagsHtml += '<span class="series-tile-tag">+' + (s.tags.length - 3) + '</span>';
    }

    html += '<div class="series-tile" data-sid="' + s.id + '">';
    html += '<img src="' + (cover || 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22300%22%20height%3D%22400%22%3E%3Crect%20fill%3D%22%23242424%22%20width%3D%22300%22%20height%3D%22400%22%2F%3E%3Ctext%20x%3D%22150%22%20y%3D%22200%22%20text-anchor%3D%22middle%22%20fill%3D%22%23666%22%20font-size%3D%2216%22%3ESin%20portada%3C%2Ftext%3E%3C%2Fsvg%3E') + '" class="series-tile-cover" alt="' + esc(s.name) + '">';
    html += '<div class="series-tile-actions">';
    html += '<div class="series-tile-action" data-action="edit-series" data-sid="' + s.id + '">&#9998;</div>';
    html += '<div class="series-tile-action" data-action="public-series" data-sid="' + s.id + '" title="Publicar lista">&#128279;</div>';
    html += '<div class="series-tile-action" data-action="edit-stags" data-sid="' + s.id + '">&#127991;</div>';
    html += '<div class="series-tile-action" data-action="move-series" data-sid="' + s.id + '">&#8644;</div>';
    html += '<div class="series-tile-action" data-action="del-series" data-sid="' + s.id + '">&#128465;</div>';
    html += '</div>';
    html += '<div class="series-tile-info">';
    html += '<div class="series-tile-name">' + esc(s.name) + '</div>';
    html += '<div class="series-tile-meta">';
    html += '<span>' + charCount + ' personaje' + (charCount !== 1 ? 's' : '') + '</span>';
    if (checkedCount > 0) html += '<span style="color:var(--accent)">&#10003; ' + checkedCount + '</span>';
    html += '</div>';
    if (s.checkLabel && s.checkLabel !== 'Check') html += '<span class="series-tile-checklabel">' + esc(s.checkLabel) + '</span>';
    if (s.tags.length) html += '<div class="series-tile-tags">' + tagsHtml + '</div>';
    html += '</div></div>';
  });

  html += '<div class="add-tile" id="btnAddTile"><span>+</span><span>Nueva lista</span></div>';
  if (!isSearching) {
    html += '<div class="add-tile" id="btnAddFolderTile"><span>&#128193;</span><span>Nueva carpeta</span></div>';
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.series-tile[data-fid]').forEach(function(tile) {
    tile.addEventListener('click', function(e) {
      if (e.target.closest('.series-tile-action')) return;
      openFolder(this.dataset.fid);
    });
  });

  grid.querySelectorAll('.series-tile[data-sid]').forEach(function(tile) {
    tile.addEventListener('click', function(e) {
      if (e.target.closest('.series-tile-action')) return;
      goToSerie(this.dataset.sid);
    });
  });

  grid.querySelectorAll('.series-tile-action').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var action = this.dataset.action;
      if (action === 'edit-folder') renameFolder(this.dataset.fid);
      else if (action === 'public-folder') togglePublicShare('folder', this.dataset.fid);
      else if (action === 'del-folder') deleteFolder(this.dataset.fid);
      else if (action === 'move-folder') openMoveFolderModal(this.dataset.fid);
      else {
        var sid = this.dataset.sid;
        if (action === 'edit-series') openEditSeriesModal(sid);
        else if (action === 'public-series') togglePublicShare('list', sid);
        else if (action === 'edit-stags') editSeriesTags(sid);
        else if (action === 'move-series') openMoveSeriesModal(sid);
        else if (action === 'del-series') {
          if (confirm('Eliminar esta serie?')) deleteSeries(sid);
        }
      }
    });
  });

  document.getElementById('btnAddTile').addEventListener('click', function() { openModal('series'); });
  var addFolderTile = document.getElementById('btnAddFolderTile');
  if (addFolderTile) addFolderTile.addEventListener('click', createFolder);
}

function deleteSeries(id) {
  data.series = data.series.filter(function(x) { return x.id !== id; });
  saveData();
  renderHome();
}

/* ===== SERIE DETAIL ===== */
function renderSerieDetail(seriesId) {
  var s = data.series.find(function(x) { return x.id === seriesId; });
  if (!s) return goHome();

  var container = document.getElementById('serieDetailContent');
  var chars = s.characters || [];
  var cover = s.cover || '';
  var fields = s.fields || [];

  var tagsHtml = '';
  s.tags.forEach(function(t) {
    tagsHtml += '<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:rgba(255,255,255,0.1);color:var(--text-secondary);backdrop-filter:blur(4px);">' + esc(t) + '</span>';
  });
  tagsHtml += '<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:rgba(255,255,255,0.05);color:var(--text-muted);border:1px dashed rgba(255,255,255,0.15);cursor:pointer;" id="btnAddSerieTag">+</span>';

  var charsHtml = '';
  chars.forEach(function(char) {
    var ctags = '';
    char.tags.forEach(function(t) { ctags += '<span class="ctag">' + esc(t) + '</span>'; });
    ctags += '<span class="ctag-add" data-cid="' + char.id + '">+</span>';

    charsHtml += '<div class="character-card">';
    charsHtml += '<img src="' + (char.image || 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22100%22%20height%3D%22100%22%3E%3Crect%20fill%3D%22%23242424%22%20width%3D%22100%22%20height%3D%22100%22%2F%3E%3C%2Fsvg%3E') + '" class="character-img" alt="' + esc(char.name) + '">';
    charsHtml += '<div class="char-actions">';
    charsHtml += '<div class="char-action" data-action="edit-char" data-cid="' + char.id + '">&#9998;</div>';
    charsHtml += '<div class="char-action" data-action="move-char" data-cid="' + char.id + '" title="Mover a otra lista">&#8644;</div>';
    charsHtml += '<div class="char-action" data-action="del-char" data-cid="' + char.id + '">&#128465;</div>';
    charsHtml += '</div>';
    charsHtml += '<div class="character-info">';
    charsHtml += '<div class="character-name">' + esc(char.name) + '</div>';
    charsHtml += '</div>';
    charsHtml += '</div>';
  });

  var html = '';
  html += '<div class="serie-hero">';
  html += '<img src="' + (cover || 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22640%22%20height%3D%22360%22%3E%3Crect%20fill%3D%22%23242424%22%20width%3D%22640%22%20height%3D%22360%22%2F%3E%3Ctext%20x%3D%22320%22%20y%3D%22180%22%20text-anchor%3D%22middle%22%20fill%3D%22%23666%22%20font-size%3D%2218%22%3ESin%20portada%3C%2Ftext%3E%3C%2Fsvg%3E') + '" class="serie-hero-img" alt="' + esc(s.name) + '">';
  html += '<div class="serie-hero-overlay"></div>';
  html += '<button class="back-btn" id="btnBack">&#8592;</button>';
  html += '<div class="serie-hero-content">';
  html += '<div class="serie-hero-title">' + esc(s.name) + '</div>';
  if (s.description) html += '<div class="serie-hero-description">' + esc(s.description) + '</div>';
  html += '<div class="serie-hero-meta">';
  html += '<span style="color:var(--text-secondary)">' + chars.length + ' item' + (chars.length !== 1 ? 's' : '') + '</span>';
  html += '<span class="serie-hero-checklabel" id="btnEditCheck">' + esc(s.checkLabel || 'Check') + '</span>';
  html += '</div>';
  if (s.tags.length) html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;">' + tagsHtml + '</div>';
  html += '</div></div>';

  html += '<div class="serie-actions-bar">';
  html += '<button class="btn" id="btnAddChar">+ Item</button>';
  html += '<button class="btn btn-ghost" id="btnEditFields">&#9881; Campos de la lista</button>';
  html += '<button class="btn btn-ghost" id="btnEditStyle">&#10022; Editar estilo de lista</button>';
  html += '<button class="btn btn-ghost" id="btnEditSerie">&#9998; Editar lista</button>';
  html += '<button class="btn btn-ghost" id="btnEditSerieTags">&#127991; Tags</button>';
  html += '<button class="btn btn-ghost btn-danger" id="btnDelSerie">&#128465; Eliminar</button>';
  html += '</div>';

  html += '<div class="character-grid">' + charsHtml;
  html += '<div class="add-character-btn" id="btnAddChar2"><span style="font-size:28px;">+</span><span>Agregar item</span></div>';
  html += '</div>';

  container.innerHTML = html;

  document.getElementById('btnBack').addEventListener('click', goHome);
  document.getElementById('btnAddChar').addEventListener('click', function() { openModal('character', s.id); });
  document.getElementById('btnAddChar2').addEventListener('click', function() { openModal('character', s.id); });
  document.getElementById('btnEditSerie').addEventListener('click', function() { openEditSeriesModal(s.id); });
  document.getElementById('btnEditFields').addEventListener('click', function() { openFieldsModal(s.id); });
  document.getElementById('btnEditStyle').addEventListener('click', function() { openStyleModal(s.id); });
  document.getElementById('btnEditSerieTags').addEventListener('click', function() { editSeriesTags(s.id); });
  document.getElementById('btnDelSerie').addEventListener('click', function() {
    if (confirm('Eliminar esta serie y todos sus personajes?')) { deleteSeries(s.id); goHome(); }
  });
  document.getElementById('btnEditCheck').addEventListener('click', function() { editCheckLabel(s.id); });

  var addTagBtn = document.getElementById('btnAddSerieTag');
  if (addTagBtn) addTagBtn.addEventListener('click', function() { editSeriesTags(s.id); });

  container.querySelectorAll('.character-card').forEach(function(card, index) {
    card.addEventListener('click', function(e) {
      if (e.target.closest('.char-action')) return;
      goToItem(s.id, chars[index].id);
    });
  });

  container.querySelectorAll('.char-action').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      var cid = this.dataset.cid;
      if (this.dataset.action === 'edit-char') openEditCharModal(s.id, cid);
      else if (this.dataset.action === 'move-char') openMoveItemModal(s.id, cid);
      else if (this.dataset.action === 'del-char') {
        if (confirm('Eliminar este personaje?')) deleteCharacter(s.id, cid);
      }
    });
  });

  container.querySelectorAll('.ctag-add').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.stopPropagation();
      editCharTags(s.id, this.dataset.cid);
    });
  });
}

function styleBlockOptions(s, selected) {
  var options = '<option value="image"' + (selected === 'image' ? ' selected' : '') + '>Imagen principal</option>';
  for (var imageIndex = 1; imageIndex < 4; imageIndex++) options += '<option value="image:' + imageIndex + '"' + (selected === 'image:' + imageIndex ? ' selected' : '') + '>Imagen adicional ' + (imageIndex + 1) + '</option>';
  options += '<option value="alias"' + (selected === 'alias' ? ' selected' : '') + '>Alias</option><option value="tags"' + (selected === 'tags' ? ' selected' : '') + '>Tags</option>';
  (s.fields || []).forEach(function(field) { options += '<option value="' + esc(field.id) + '"' + (selected === field.id ? ' selected' : '') + '>' + esc(field.label) + '</option>'; });
  return options;
}

function styleBlockRow(s, block, index) {
  var col = block.col || 1;
  var row = block.row || 1;
  var colSpan = block.colSpan || block.span || (block.size === 'large' ? 2 : 1);
  var rowSpan = block.rowSpan || 1;
  function options(max, selected, suffix) { var html = ''; for (var i = 1; i <= max; i++) html += '<option value="' + i + '"' + (i === selected ? ' selected' : '') + '>' + i + (suffix || '') + '</option>'; return html; }
  return '<div class="style-block-row' + (index === styleEditorSelected ? ' selected' : '') + '" draggable="true" data-layout-index="' + (index === undefined ? '' : index) + '" data-block-type="' + esc(block.type) + '">' +
    '<span class="style-drag-handle" title="Arrastrar para ordenar">⠿</span>' +
    '<select class="style-block-field">' + styleBlockOptions(s, block.field) + '</select>' +
    '<select class="style-block-size"><option value="small"' + (block.size === 'small' ? ' selected' : '') + '>Pequeño</option><option value="medium"' + (block.size === 'medium' || !block.size ? ' selected' : '') + '>Mediano</option><option value="large"' + (block.size === 'large' ? ' selected' : '') + '>Grande</option></select>' +
    '<select class="style-block-col" title="Columna">' + options(4, col, '') + '</select><select class="style-block-rowpos" title="Fila">' + options(8, row, '') + '</select><select class="style-block-colspan" title="Ancho">' + options(4, colSpan, ' col.') + '</select><select class="style-block-rowspan" title="Alto">' + options(3, rowSpan, ' fila') + '</select>' +
    '<button type="button" class="style-move-up" title="Subir">↑</button><button type="button" class="style-move-down" title="Bajar">↓</button><button type="button" class="field-delete style-delete" title="Eliminar">×</button></div>';
}

function collectListLayout() {
  return { columns: Number(document.getElementById('styleColumns').value) || 2, blocks: Array.from(document.querySelectorAll('#styleBlocks .style-block-row')).map(function(row) { var style = row._visualStyle || {}; return { type: row.dataset.blockType, field: row.querySelector('.style-block-field').value, size: row.querySelector('.style-block-size').value, col: Number(row.querySelector('.style-block-col').value), row: Number(row.querySelector('.style-block-rowpos').value), colSpan: Number(row.querySelector('.style-block-colspan').value), rowSpan: Number(row.querySelector('.style-block-rowspan').value), style: style }; }) };
}

function bindStyleDrag(row) {
  row.addEventListener('dragstart', function() { row.classList.add('dragging'); });
  row.addEventListener('dragend', function() { row.classList.remove('dragging'); var list = data.series.find(function(x) { return x.id === currentSeriesId; }); if (list) renderStyleEditorPreview(list); });
  row.addEventListener('dragover', function(e) {
    e.preventDefault();
    var dragging = document.querySelector('.style-block-row.dragging');
    if (dragging && dragging !== row) {
      var box = row.getBoundingClientRect();
      box.top + box.height / 2 < e.clientY ? row.before(dragging) : row.after(dragging);
    }
  });
}

function openStyleModal(seriesId) {
  return openFullStyleEditor(seriesId);
  /* Legacy editor retained for data compatibility. */
  /*
  var s = data.series.find(function(x) { return x.id === seriesId; });
  var layout = getListLayout(s);
  currentModal = null; currentSeriesId = seriesId; currentItemId = null; styleEditorSelected = 0;
  var editor = document.getElementById('styleEditorContent');
  editor.innerHTML = '<div class="style-editor-page"><div class="style-editor-top"><button class="btn btn-ghost" id="btnBackStyle">&#8592; Volver a la lista</button><div><h2>Editar estilo de lista</h2><p>' + esc(s.name) + '</p></div><button class="btn" id="btnSaveStyle">Guardar cambios</button></div><div class="style-editor-workspace"><section class="style-editor-controls"><p class="style-editor-intro">Selecciona un bloque en la vista previa o en la lista. Los cambios se reflejan inmediatamente.</p><div class="form-group"><label>Columnas de la ficha</label><select id="styleColumns"><option value="1"' + (layout.columns === 1 ? ' selected' : '') + '>1 columna</option><option value="2"' + (layout.columns === 2 || !layout.columns ? ' selected' : '') + '>2 columnas</option><option value="3"' + (layout.columns === 3 ? ' selected' : '') + '>3 columnas</option><option value="4"' + (layout.columns === 4 ? ' selected' : '') + '>4 columnas</option></select></div><div id="styleBlocks">' + layout.blocks.map(function(block, index) { return styleBlockRow(s, block, index); }).join('') + '</div><button class="btn btn-ghost" id="btnAddStyleBlock">+ Agregar bloque</button><div id="styleVisualControls" class="style-visual-controls"><h3>Estilo del bloque</h3><div class="style-control-grid"><label>Fondo<input id="styleBgColor" type="color" value="#242424"></label><label>Color de texto<input id="styleTextColor" type="color" value="#f0f0f0"></label><label>Fuente<select id="styleFont"><option value="inherit">Predeterminada</option><option value="Arial, sans-serif">Arial</option><option value="Georgia, serif">Georgia</option><option value="Verdana, sans-serif">Verdana</option><option value="monospace">Monoespaciada</option></select></label><label>Tamaño <output id="styleFontSizeValue">14px</output><input id="styleFontSize" type="range" min="11" max="32" value="14"></label></div></div></section><section class="style-editor-preview"><div class="style-preview-label">Vista previa directa · haz clic en un bloque para editarlo</div><div id="styleLivePreview"></div></section></div></div>';
  document.getElementById('btnAddStyleBlock').addEventListener('click', function() {
    var blocks = document.getElementById('styleBlocks');
    blocks.insertAdjacentHTML('beforeend', styleBlockRow(s, { type: 'text', field: (s.fields[0] || {}).id || 'alias', size: 'medium' }));
    blocks.lastElementChild.dataset.layoutIndex = blocks.children.length - 1;
    bindStyleDrag(blocks.lastElementChild);
    renderStyleEditorPreview(s);
  });
  document.querySelectorAll('.style-block-row').forEach(bindStyleDrag);
  document.querySelectorAll('.style-block-row').forEach(function(row, index) { row._visualStyle = layout.blocks[index] && layout.blocks[index].style ? layout.blocks[index].style : {}; });
  document.getElementById('btnBackStyle').addEventListener('click', function() { goToSerie(s.id); });
  document.getElementById('btnSaveStyle').addEventListener('click', function() {
    s.layout = collectListLayout(); saveData(); goToSerie(s.id);
  });
  editor.addEventListener('click', function(e) {
    var up = e.target.closest('.style-move-up');
    var down = e.target.closest('.style-move-down');
    var del = e.target.closest('.style-delete');
    if (del) del.closest('.style-block-row').remove();
    if (up || down) { var row = (up || down).closest('.style-block-row'); var sibling = up ? row.previousElementSibling : row.nextElementSibling; if (sibling) up ? sibling.before(row) : sibling.after(row); }
    if (up || down || del) renderStyleEditorPreview(s);
  });
  editor.addEventListener('input', function() { renderStyleEditorPreview(s); });
  editor.addEventListener('change', function() { renderStyleEditorPreview(s); });
  editor.addEventListener('click', function(e) {
    var row = e.target.closest('.style-block-row');
    var previewBlock = e.target.closest('[data-layout-index]');
    var index = row ? Number(row.dataset.layoutIndex) : previewBlock ? Number(previewBlock.dataset.layoutIndex) : -1;
    if (index >= 0 && !e.target.closest('button')) { styleEditorSelected = index; syncStyleControls(); renderStyleEditorPreview(s); }
  });
  ['styleBgColor', 'styleTextColor', 'styleFont', 'styleFontSize'].forEach(function(id) { document.getElementById(id).addEventListener('input', updateSelectedStyle); document.getElementById(id).addEventListener('change', updateSelectedStyle); });
  renderStyleEditorPreview(s);
  showPage('pageStyleEditor');
  */
}

function openFullStyleEditor(seriesId) {
  var s = data.series.find(function(x) { return x.id === seriesId; });
  if (!s) return;
  currentSeriesId = seriesId;
  styleEditorDraft = JSON.parse(JSON.stringify(getListLayout(s)));
  if (!styleEditorDraft.titleStyle) styleEditorDraft.titleStyle = {};
  var editor = document.getElementById('styleEditorContent');
  editor.innerHTML = '<div class="full-style-editor"><header><button class="btn btn-ghost" id="fullStyleBack">&#8592; Volver</button><div><h2>Plantilla de ' + esc(s.name) + '</h2><p>Edita directamente la ficha del item</p></div><button class="btn" id="fullStyleSave">Guardar plantilla</button></header><div class="full-style-body"><main class="full-style-canvas"><div class="style-preview-label">Vista previa directa · mueve y redimensiona cada objeto</div><div id="fullStylePreview"></div></main><aside class="full-style-inspector"><div id="fullStyleControls"></div><div class="inspector-add"><label>Agregar bloque</label><select id="fullStyleAddType"><option value="text">Campo de texto</option><option value="image">Imagen principal</option><option value="image:1">Imagen adicional</option><option value="alias">Alias</option><option value="tags">Tags</option></select><button class="btn btn-ghost" id="fullStyleAdd">+ Agregar</button></div></aside></div></div>';
  document.getElementById('fullStyleBack').addEventListener('click', function() { goToSerie(s.id); });
  document.getElementById('fullStyleSave').addEventListener('click', function() { s.layout = styleEditorDraft; saveData(); goToSerie(s.id); });
  document.getElementById('fullStyleAdd').addEventListener('click', function() {
    var field = document.getElementById('fullStyleAddType').value;
    if (field === 'text') field = (s.fields[0] || {}).id || 'alias';
    styleEditorDraft.blocks.push({ type: /^image/.test(field) ? 'image' : 'text', field: field, size: 'medium', x: 4, y: 4, width: 30, height: 18, style: {} });
    reflowLayout(styleEditorDraft);
    styleEditorSelected = styleEditorDraft.blocks.length - 1;
    renderFullStyleEditor(s);
  });
  renderFullStyleEditor(s);
  showPage('pageStyleEditor');
}

function renderFullStyleEditor(s) {
  renderFullStylePreview(s);
  var controls = document.getElementById('fullStyleControls');
  if (!controls) return;
  if (styleEditorSelectionType === 'title') {
    var title = styleEditorDraft.titleStyle || {};
    controls.innerHTML = '<h3>Título</h3><label>Color<input id="fullTitleColor" type="color" value="' + (title.color || '#f0f0f0') + '"></label><label>Fuente<select id="fullTitleFont"><option value="inherit">Predeterminada</option><option value="Arial, sans-serif">Arial</option><option value="Georgia, serif">Georgia</option><option value="Verdana, sans-serif">Verdana</option><option value="monospace">Monoespaciada</option></select></label><label>Tamaño <output id="fullTitleSizeOut">' + (title.fontSize || 22) + 'px</output><input id="fullTitleSize" type="range" min="16" max="48" value="' + (title.fontSize || 22) + '"></label>';
    if (title.fontFamily) document.getElementById('fullTitleFont').value = title.fontFamily;
    ['fullTitleColor', 'fullTitleFont', 'fullTitleSize'].forEach(function(id) { document.getElementById(id).addEventListener('input', updateFullTitleStyle); document.getElementById(id).addEventListener('change', updateFullTitleStyle); });
    return;
  }
  var block = styleEditorDraft.blocks[styleEditorSelected];
  if (!block) { controls.innerHTML = '<p class="inspector-help">Selecciona un bloque para editarlo.</p>'; return; }
  var visual = block.style || {};
  var titleFont = visual.titleFontFamily || visual.fontFamily || 'inherit';
  var titleSize = visual.titleFontSize || 11;
  var titleColor = visual.titleColor || '#aaa';
  var titleAlign = visual.titleAlign || 'left';
  var contentFont = visual.contentFontFamily || visual.fontFamily || 'inherit';
  var contentSize = visual.contentFontSize || visual.fontSize || 14;
  var contentColor = visual.contentColor || visual.color || '#f0f0f0';
  var contentAlign = visual.contentAlign || 'left';
  controls.innerHTML = '<h3>Título de bloque</h3><label>Fuente<select id="fullTitleFont"><option value="inherit">Predeterminada</option><option value="Arial, sans-serif">Arial</option><option value="Georgia, serif">Georgia</option><option value="Verdana, sans-serif">Verdana</option><option value="monospace">Monoespaciada</option></select></label><label>Tamaño <output id="fullTitleSizeOut">' + titleSize + 'px</output><input id="fullTitleSize" type="range" min="9" max="28" value="' + titleSize + '"></label><label>Color de texto<input id="fullTitleColor" type="color" value="' + titleColor + '"></label><label>Alineado<select id="fullTitleAlign"><option value="left">Izquierdo</option><option value="center">Centro</option><option value="right">Derecho</option></select></label><h3 class="inspector-block-title">Contenido del bloque</h3><label>Fuente<select id="fullContentFont"><option value="inherit">Predeterminada</option><option value="Arial, sans-serif">Arial</option><option value="Georgia, serif">Georgia</option><option value="Verdana, sans-serif">Verdana</option><option value="monospace">Monoespaciada</option></select></label><label>Tamaño <output id="fullContentSizeOut">' + contentSize + 'px</output><input id="fullContentSize" type="range" min="9" max="40" value="' + contentSize + '"></label><label>Color de texto<input id="fullContentColor" type="color" value="' + contentColor + '"></label><label>Alineado<select id="fullContentAlign"><option value="left">Izquierdo</option><option value="center">Centro</option><option value="right">Derecho</option></select></label><h3 class="inspector-block-title">Bloque</h3><label>Color de fondo<input id="fullBg" type="color" value="' + (visual.background || '#242424') + '"></label><label class="inspector-check"><input id="fullWrap" type="checkbox"' + (visual.wrap !== false ? ' checked' : '') + '> Ajustar texto al bloque</label><label class="inspector-check aspect-lock"><input id="fullLockAspect" type="checkbox"' + (visual.lockAspect ? ' checked' : '') + '> Bloquear relación de aspecto</label><div class="inspector-grid"><label>Posición X (%)<input id="fullX" type="number" min="0" max="100" step="0.5" value="' + (block.x || 0) + '"></label><label>Posición Y (%)<input id="fullY" type="number" min="0" max="100" step="0.5" value="' + (block.y || 0) + '"></label><label>Ancho (%)<input id="fullWidth" type="number" min="1" max="100" step="0.5" value="' + (block.width || 30) + '"></label><label>Alto (%)<input id="fullHeight" type="number" min="1" max="100" step="0.5" value="' + (block.height || 18) + '"></label></div><button class="btn btn-danger full-remove" id="fullRemove">Eliminar bloque</button>';
  document.getElementById('fullTitleFont').value = titleFont;
  document.getElementById('fullTitleAlign').value = titleAlign;
  document.getElementById('fullContentFont').value = contentFont;
  document.getElementById('fullContentAlign').value = contentAlign;
  if (block.type === 'group') controls.innerHTML += '<label>Columnas internas<input id="fullGroupColumns" type="number" min="1" max="4" value="' + (block.columns || 2) + '"></label><label>Filas internas<input id="fullGroupRows" type="number" min="1" max="8" value="' + (block.rows || 1) + '"></label>';
  ['fullTitleFont', 'fullTitleSize', 'fullTitleColor', 'fullTitleAlign', 'fullContentFont', 'fullContentSize', 'fullContentColor', 'fullContentAlign', 'fullBg', 'fullWrap', 'fullLockAspect', 'fullX', 'fullY', 'fullWidth', 'fullHeight', 'fullGroupColumns', 'fullGroupRows'].forEach(function(id) { var input = document.getElementById(id); if (input) { input.addEventListener('input', updateFullStyle); input.addEventListener('change', updateFullStyle); } });
  document.getElementById('fullRemove').addEventListener('click', function() { styleEditorDraft.blocks.splice(styleEditorSelected, 1); styleEditorSelected = Math.max(0, styleEditorSelected - 1); renderFullStyleEditor(s); });
}

function updateFullTitleStyle() {
  styleEditorDraft.titleStyle = { color: document.getElementById('fullTitleColor').value, fontFamily: document.getElementById('fullTitleFont').value, fontSize: Number(document.getElementById('fullTitleSize').value) };
  document.getElementById('fullTitleSizeOut').textContent = styleEditorDraft.titleStyle.fontSize + 'px';
  renderFullStylePreview(data.series.find(function(x) { return x.id === currentSeriesId; }));
}

function updateFullStyle(event) {
  var block = styleEditorDraft && styleEditorDraft.blocks[styleEditorSelected];
  if (!block) return;
  var previousVisual = block.style || {};
  block.style = {
    background: document.getElementById('fullBg').value,
    titleFontFamily: document.getElementById('fullTitleFont').value,
    titleFontSize: Number(document.getElementById('fullTitleSize').value),
    titleColor: document.getElementById('fullTitleColor').value,
    titleAlign: document.getElementById('fullTitleAlign').value,
    contentFontFamily: document.getElementById('fullContentFont').value,
    contentFontSize: Number(document.getElementById('fullContentSize').value),
    contentColor: document.getElementById('fullContentColor').value,
    contentAlign: document.getElementById('fullContentAlign').value,
    wrap: document.getElementById('fullWrap').checked
  };
  var x = Math.max(0, Math.min(100, Number(document.getElementById('fullX').value) || 0));
  var y = Math.max(0, Math.min(100, Number(document.getElementById('fullY').value) || 0));
  var width = Math.max(1, Math.min(100 - x, Number(document.getElementById('fullWidth').value) || 30));
  var height = Math.max(1, Math.min(100 - y, Number(document.getElementById('fullHeight').value) || 18));
  var lockAspect = document.getElementById('fullLockAspect').checked;
  var changedId = event && event.target ? event.target.id : '';
  if (lockAspect && !previousVisual.lockAspect) block.aspectRatio = width / Math.max(1, height);
  if (lockAspect && (changedId === 'fullWidth' || changedId === 'fullHeight' || changedId === 'fullLockAspect')) {
    var ratio = Number(block.aspectRatio) || width / Math.max(1, height);
    if (changedId === 'fullHeight') width = Math.min(100 - x, height * ratio);
    else height = Math.min(100 - y, width / ratio);
  }
  block.x = x;
  block.y = y;
  block.width = Math.max(1, width);
  block.height = Math.max(1, height);
  block.style.lockAspect = lockAspect;
  document.getElementById('fullX').value = block.x;
  document.getElementById('fullY').value = block.y;
  document.getElementById('fullWidth').value = block.width;
  document.getElementById('fullHeight').value = block.height;
  if (block.type === 'group' && document.getElementById('fullGroupColumns')) block.columns = Number(document.getElementById('fullGroupColumns').value) || 2;
  if (block.type === 'group' && document.getElementById('fullGroupRows')) block.rows = Number(document.getElementById('fullGroupRows').value) || 1;
  document.getElementById('fullTitleSizeOut').textContent = block.style.titleFontSize + 'px';
  document.getElementById('fullContentSizeOut').textContent = block.style.contentFontSize + 'px';
  renderFullStylePreview(data.series.find(function(x) { return x.id === currentSeriesId; }));
}

function renderFullStylePreview(s) {
  var preview = document.getElementById('fullStylePreview');
  if (!preview || !styleEditorDraft) return;
  var item = (s.characters || [])[0] || { name: 'Item de ejemplo', image: '', images: [], values: {} };
  preview.innerHTML = renderItemPageMarkup(s, item, styleEditorDraft, true);
  var grid = preview.querySelector('.item-layout');
  if (grid) {
    grid.addEventListener('dragover', function(e) {
      // Los subgrids manejan su propio espacio; la grilla principal solo recibe huecos propios.
      if (e.target.closest('.nested-item-layout')) return;
      e.preventDefault();
      grid.classList.add('grid-drop-active');
    });
    grid.addEventListener('dragleave', function(e) {
      if (e.target === grid || !grid.contains(e.relatedTarget)) grid.classList.remove('grid-drop-active');
    });
    grid.addEventListener('drop', function(e) {
      if (e.target.closest('.nested-item-layout')) return;
      e.preventDefault();
      e.stopPropagation();
      grid.classList.remove('grid-drop-active');
      var fromIndex = styleEditorDragging;
      var dragged = styleEditorDraft.blocks[fromIndex];
      if (fromIndex === null || fromIndex === undefined || !dragged) return;
      var rect = grid.getBoundingClientRect();
      var width = Number(dragged.width) || 30;
      var height = Number(dragged.height) || 18;
      var targetX = Math.max(0, Math.min(100 - width, (e.clientX - rect.left) / rect.width * 100 - width / 2));
      var targetY = Math.max(0, Math.min(100 - height, (e.clientY - rect.top) / rect.height * 100 - height / 2));
      var snap = 1.5;
      styleEditorDraft.blocks.forEach(function(other, index) {
        if (index === fromIndex) return;
        var ox = Number(other.x) || 0, oy = Number(other.y) || 0;
        var ow = Number(other.width) || 30, oh = Number(other.height) || 18;
        [ox, ox + ow, ox - width, ox + ow - width, ox + (ow - width) / 2].forEach(function(value) { if (Math.abs(targetX - value) <= snap) targetX = value; });
        [oy, oy + oh, oy - height, oy + oh - height, oy + (oh - height) / 2].forEach(function(value) { if (Math.abs(targetY - value) <= snap) targetY = value; });
      });
      targetX = Math.max(0, Math.min(100 - width, targetX));
      targetY = Math.max(0, Math.min(100 - height, targetY));
      dragged.x = targetX;
      dragged.y = targetY;
      styleEditorSelected = fromIndex;
      styleEditorDragging = null;
      renderFullStyleEditor(s);
    });
  }
  preview.querySelectorAll('[data-layout-index]').forEach(function(el) {
    el.draggable = true;
    el.addEventListener('click', function(e) { e.stopPropagation(); styleEditorSelectionType = 'block'; styleEditorSelected = Number(el.dataset.layoutIndex); renderFullStyleEditor(s); });
    el.addEventListener('dragstart', function() { styleEditorDragging = Number(el.dataset.layoutIndex); el.classList.add('dragging'); });
    el.addEventListener('dragend', function() { el.classList.remove('dragging'); });
    el.addEventListener('dragover', function(e) { e.preventDefault(); });
    el.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var fromIndex = styleEditorDragging;
      var toIndex = Number(el.dataset.layoutIndex);
      if (fromIndex === null || fromIndex === toIndex || !styleEditorDraft.blocks[fromIndex] || !styleEditorDraft.blocks[toIndex]) return;
      var from = styleEditorDraft.blocks[fromIndex];
      var to = styleEditorDraft.blocks[toIndex];
      var coordinates = { x: from.x, y: from.y, width: from.width, height: from.height };
      from.x = to.x; from.y = to.y; from.width = to.width; from.height = to.height;
      to.x = coordinates.x; to.y = coordinates.y; to.width = coordinates.width; to.height = coordinates.height;
      styleEditorSelected = fromIndex;
      styleEditorDragging = null;
      renderFullStyleEditor(s);
    });
  });
  var title = preview.querySelector('[data-template-title]');
  if (title) title.addEventListener('click', function(e) { e.stopPropagation(); styleEditorSelectionType = 'title'; renderFullStyleEditor(s); });
  var selected = styleEditorSelectionType === 'title' ? title : preview.querySelector('[data-layout-index="' + styleEditorSelected + '"]');
  if (selected) selected.classList.add('template-selected');
}

function renderItemPageMarkup(s, item, layout, isTemplate) {
  var images = item.images && item.images.length ? item.images : (item.image ? [item.image] : []);
  var cover = item.image || images[0] || '';
  var rows = (layout.blocks || []).map(function(block, index) { return renderLayoutBlock(block, item, s, index); }).join('');
  if (!rows) rows = '<div class="item-empty-data">Este item todavía no tiene datos adicionales.</div>';
  var placeholder = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22640%22%20height%3D%22360%22%3E%3Crect%20fill%3D%22%23242424%22%20width%3D%22640%22%20height%3D%22360%22%2F%3E%3C/svg%3E';
  var titleStyle = layout.titleStyle || {};
  var titleInline = 'color:' + (titleStyle.color || '#f0f0f0') + ';font-family:' + (titleStyle.fontFamily || 'inherit') + ';font-size:' + (titleStyle.fontSize || 22) + 'px;';
  var titleAttr = isTemplate ? ' data-template-title' : '';
  var html = '<div class="item-hero"><img src="' + (cover || placeholder) + '" class="item-hero-img" alt="' + esc(item.name) + '"><div class="serie-hero-overlay"></div>' + (isTemplate ? '<span class="back-btn template-back">&#8592;</span>' : '<button class="back-btn" id="btnBackItem">&#8592;</button>') + '<div class="item-hero-content"><div class="serie-hero-title"' + titleAttr + ' style="' + titleInline + '">' + esc(item.name) + '</div><div class="item-hero-parent">' + esc(s.name) + '</div></div></div>';
  html += '<div class="serie-actions-bar">' + (isTemplate ? '<span class="btn btn-ghost template-action">&#9998; Editar item</span><span class="btn btn-ghost template-action btn-danger">&#128465; Eliminar</span>' : '<button class="btn btn-ghost" id="btnEditItem">&#9998; Editar item</button><button class="btn btn-ghost" id="btnChangeItemCover">&#128444; Cambiar portada</button><button class="btn btn-ghost" id="btnMoveItem">&#8644; Mover a lista</button><button class="btn btn-ghost btn-danger" id="btnDelItem">&#128465; Eliminar</button>') + '</div>';
  html += '<section class="item-data-section"><h3>Información</h3><div class="item-layout free-layout' + (isTemplate ? ' template-grid-visible' : '') + '" style="--canvas-height:' + (layout.canvasHeight || 640) + 'px">' + rows + '</div></section>';
  if (images.length > 1) html += '<section class="item-gallery"><h3>Imágenes</h3><div>' + images.map(function(image) { return '<img src="' + esc(image) + '" alt="' + esc(item.name) + '">'; }).join('') + '</div></section>';
  return html;
}

function syncStyleControls() {
  var row = document.querySelectorAll('#styleBlocks .style-block-row')[styleEditorSelected];
  var style = row && row._visualStyle ? row._visualStyle : {};
  if (document.getElementById('styleBgColor')) document.getElementById('styleBgColor').value = style.background || '#242424';
  if (document.getElementById('styleTextColor')) document.getElementById('styleTextColor').value = style.color || '#f0f0f0';
  if (document.getElementById('styleFont')) document.getElementById('styleFont').value = style.fontFamily || 'inherit';
  if (document.getElementById('styleFontSize')) document.getElementById('styleFontSize').value = style.fontSize || 14;
  if (document.getElementById('styleFontSizeValue')) document.getElementById('styleFontSizeValue').textContent = (style.fontSize || 14) + 'px';
}

function updateSelectedStyle() {
  var row = document.querySelectorAll('#styleBlocks .style-block-row')[styleEditorSelected];
  if (!row) return;
  row._visualStyle = { background: document.getElementById('styleBgColor').value, color: document.getElementById('styleTextColor').value, fontFamily: document.getElementById('styleFont').value, fontSize: Number(document.getElementById('styleFontSize').value) };
  document.getElementById('styleFontSizeValue').textContent = row._visualStyle.fontSize + 'px';
  var s = data.series.find(function(x) { return x.id === currentSeriesId; });
  renderStyleEditorPreview(s);
}

function renderStyleEditorPreview(s) {
  var preview = document.getElementById('styleLivePreview');
  if (!preview) return;
  document.querySelectorAll('#styleBlocks .style-block-row').forEach(function(row, index) { row.dataset.layoutIndex = index; });
  var layout = collectListLayout();
  var item = (s.characters || [])[0] || { name: 'Item de ejemplo', image: '', images: [], values: {} };
  var blocks = layout.blocks.map(function(block, index) { return renderLayoutBlock(block, item, s, index); }).join('');
  preview.innerHTML = '<div class="style-preview-card"><div class="style-preview-title">' + esc(item.name || 'Item de ejemplo') + '</div><div class="item-layout" style="--layout-columns:' + layout.columns + ';--layout-rows:' + (layout.rows || 1) + '">' + (blocks || '<div class="item-empty-data">Agrega bloques para ver la plantilla.</div>') + '</div></div>';
  syncStyleControls();
}

function renderLayoutBlock(block, item, s, layoutIndex, columnsOverride) {
  var layout = styleEditorDraft && layoutIndex !== undefined ? styleEditorDraft : getListLayout(s);
  normalizeFreeLayout(layout);
  var x = Math.max(0, Math.min(100, Number(block.x) || 0));
  var y = Math.max(0, Math.min(100, Number(block.y) || 0));
  var width = Math.max(1, Math.min(100 - x, Number(block.width) || 30));
  var height = Math.max(1, Math.min(100 - y, Number(block.height) || 18));
  var freeStyle = 'left:' + x + '%;top:' + y + '%;width:' + width + '%;height:' + height + '%;';
  var visual = block.style || {};
  var visualStyle = 'background-color:' + (visual.background || '#242424') + ';color:' + (visual.color || '#f0f0f0') + ';font-family:' + (visual.fontFamily || 'inherit') + ';font-size:' + (visual.fontSize || 14) + 'px;' + freeStyle;
  var blockAttr = layoutIndex === undefined ? '' : ' data-layout-index="' + layoutIndex + '"';
  if (block.type === 'group') {
    var groupColumns = block.columns || 2;
    var children = (block.children || []).map(function(child) { return renderLayoutBlock(child, item, s, undefined, groupColumns); }).join('');
    return '<div class="layout-block layout-group' + (layoutIndex === undefined ? '' : ' direct-layout-block') + '"' + blockAttr + ' style="' + visualStyle + '"><div class="nested-item-layout' + (styleEditorDraft && layoutIndex !== undefined ? ' template-grid-visible' : '') + '" style="--layout-columns:' + groupColumns + ';--layout-rows:' + (block.rows || 1) + '">' + children + '</div></div>';
  }
  var value = block.field === 'alias' ? item.alias : block.field === 'tags' ? (item.tags || []).join(', ') : /^image(?::\d+)?$/.test(block.field) ? '' : item.values && item.values[block.field];
  if (/^image(?::\d+)?$/.test(block.field)) {
    var imageNumber = block.field.indexOf(':') > -1 ? Number(block.field.split(':')[1]) : 0;
    var image = item.images && item.images[imageNumber] ? item.images[imageNumber] : (imageNumber === 0 ? item.image : '');
    return image ? '<div class="layout-block' + (layoutIndex === undefined ? '' : ' direct-layout-block') + ' layout-image size-' + block.size + '"' + blockAttr + ' style="' + visualStyle + '"><img src="' + esc(image) + '" alt="' + esc(item.name) + '"></div>' : '';
  }
  if (value === undefined || value === '') return '';
  var label = block.field === 'alias' ? 'Alias' : block.field === 'tags' ? 'Tags' : ((s.fields || []).find(function(field) { return field.id === block.field; }) || {}).label || block.field;
  var titleStyle = 'font-family:' + (visual.titleFontFamily || visual.fontFamily || 'inherit') + ';font-size:' + (visual.titleFontSize || 11) + 'px;color:' + (visual.titleColor || '#aaa') + ';text-align:' + (visual.titleAlign || 'left') + ';';
  var contentStyle = 'font-family:' + (visual.contentFontFamily || visual.fontFamily || 'inherit') + ';font-size:' + (visual.contentFontSize || visual.fontSize || 14) + 'px;color:' + (visual.contentColor || visual.color || '#f0f0f0') + ';text-align:' + (visual.contentAlign || 'left') + ';white-space:' + (visual.wrap === false ? 'nowrap' : 'normal') + ';';
  return '<div class="layout-block' + (layoutIndex === undefined ? '' : ' direct-layout-block') + ' layout-text size-' + block.size + '"' + blockAttr + ' style="' + visualStyle + '"><span style="' + titleStyle + '">' + esc(label) + '</span><div style="' + contentStyle + '">' + esc(String(value)).replace(/\n/g, '<br>') + '</div></div>';
}

function renderItemDetail(seriesId, itemId) {
  var s = data.series.find(function(x) { return x.id === seriesId; });
  var item = s && (s.characters || []).find(function(x) { return x.id === itemId; });
  if (!s || !item) return goToSerie(seriesId);
  var layout = getListLayout(s);
  document.getElementById('itemDetailContent').innerHTML = renderItemPageMarkup(s, item, layout, false);
  document.getElementById('btnBackItem').addEventListener('click', function() { goToSerie(s.id); });
  document.getElementById('btnEditItem').addEventListener('click', function() { openEditCharModal(s.id, item.id); });
  document.getElementById('btnChangeItemCover').addEventListener('click', function() { openEditCharModal(s.id, item.id); });
  document.getElementById('btnMoveItem').addEventListener('click', function() { openMoveItemModal(s.id, item.id); });
  document.getElementById('btnDelItem').addEventListener('click', function() { if (confirm('Eliminar este item?')) { deleteCharacter(s.id, item.id); goToSerie(s.id); } });
}

function toggleCheck(seriesId, charId) {
  var s = data.series.find(function(x) { return x.id === seriesId; });
  var c = s.characters.find(function(x) { return x.id === charId; });
  c.checked = !c.checked;
  saveData();
  renderSerieDetail(seriesId);
}

function deleteCharacter(seriesId, charId) {
  var s = data.series.find(function(x) { return x.id === seriesId; });
  s.characters = s.characters.filter(function(x) { return x.id !== charId; });
  saveData();
  renderSerieDetail(seriesId);
}

function listOptions(excludeId, selectedId) {
  return data.series.filter(function(list) { return list.id !== excludeId; }).map(function(list) {
    return '<option value="' + esc(list.id) + '"' + (list.id === selectedId ? ' selected' : '') + '>' + esc(list.name) + '</option>';
  }).join('');
}

function openMoveItemModal(seriesId, charId) {
  var source = data.series.find(function(list) { return list.id === seriesId; });
  var item = source && source.characters.find(function(character) { return character.id === charId; });
  if (!source || !item) return;
  if (!data.series.some(function(list) { return list.id !== seriesId; })) return alert('Crea otra lista antes de mover este item.');
  currentModal = 'moveItem';
  currentSeriesId = seriesId;
  currentCharId = charId;
  document.getElementById('modalTitle').textContent = 'Mover item';
  document.getElementById('btnSave').textContent = 'Mover item';
  document.getElementById('modalBody').innerHTML = '<p class="modal-help">El item conservará sus datos e imágenes y utilizará automáticamente el estilo de la lista de destino.</p><div class="form-group"><label>Lista de destino</label><select id="moveItemTarget">' + listOptions(seriesId) + '</select></div>';
  document.getElementById('modal').classList.add('active');
}

function editCheckLabel(seriesId) {
  var s = data.series.find(function(x) { return x.id === seriesId; });
  var label = prompt('Que objetivo quieres trackear? Ej: Coleccionar, Dibujar, Cosplay, Ver...', s.checkLabel || 'Check');
  if (label !== null) {
    s.checkLabel = label.trim() || 'Check';
    saveData();
    if (currentSeriesId) renderSerieDetail(currentSeriesId);
    else renderHome();
  }
}

function editSeriesTags(seriesId) {
  var s = data.series.find(function(x) { return x.id === seriesId; });
  var newTags = prompt('Tags de la serie (separados por coma):', s.tags.join(', '));
  if (newTags !== null) {
    s.tags = newTags.split(',').map(function(t) { return t.trim().toLowerCase(); }).filter(function(t) { return t; });
    s.tags.forEach(addToAllTags);
    saveData();
    renderHome();
    if (currentSeriesId === seriesId) renderSerieDetail(seriesId);
  }
}

function editCharTags(seriesId, charId) {
  var s = data.series.find(function(x) { return x.id === seriesId; });
  var c = s.characters.find(function(x) { return x.id === charId; });
  var newTags = prompt('Tags del personaje (separados por coma):', c.tags.join(', '));
  if (newTags !== null) {
    c.tags = newTags.split(',').map(function(t) { return t.trim().toLowerCase(); }).filter(function(t) { return t; });
    c.tags.forEach(addToAllTags);
    saveData();
    renderSerieDetail(seriesId);
  }
}

function openFieldsModal(seriesId) {
  var s = data.series.find(function(x) { return x.id === seriesId; });
  currentModal = 'fields'; currentSeriesId = seriesId; currentCharId = null;
  var modal = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = 'Campos de la lista';
  var fields = s.fields || [];
  var html = '<p class="modal-help">Estos campos se aplican a todos los items de esta lista. Puedes crear filas de texto, números, fechas o enlaces.</p>';
  html += '<div id="fieldsEditor">';
  fields.forEach(function(field) { html += fieldEditorRow(field); });
  html += '</div><button class="btn btn-ghost field-add" id="btnAddField">+ Agregar campo</button>';
  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('btnAddField').addEventListener('click', function() {
    document.getElementById('fieldsEditor').insertAdjacentHTML('beforeend', fieldEditorRow({ id: generateId(), label: '', type: 'text' }));
  });
  modal.classList.add('active');
}

function fieldEditorRow(field) {
  return '<div class="field-editor-row" data-field-id="' + esc(field.id) + '">' +
    '<input class="field-label" type="text" value="' + esc(field.label || '') + '" placeholder="Título (Ej. Director)">' +
    '<select class="field-type"><option value="text"' + (field.type === 'text' ? ' selected' : '') + '>Texto</option><option value="textarea"' + (field.type === 'textarea' ? ' selected' : '') + '>Texto largo</option><option value="number"' + (field.type === 'number' ? ' selected' : '') + '>Número</option><option value="date"' + (field.type === 'date' ? ' selected' : '') + '>Fecha</option><option value="url"' + (field.type === 'url' ? ' selected' : '') + '>Enlace</option></select>' +
    '<button class="field-delete" type="button" title="Eliminar campo">×</button></div>';
}

function collectFields() {
  return Array.from(document.querySelectorAll('#fieldsEditor .field-editor-row')).map(function(row) {
    return { id: row.dataset.fieldId || generateId(), label: row.querySelector('.field-label').value.trim(), type: row.querySelector('.field-type').value };
  }).filter(function(field) { return field.label; });
}

function itemFieldsHtml(s, item) {
  return (s.fields || []).map(function(field) {
    var value = item && item.values ? (item.values[field.id] || '') : '';
    var control = field.type === 'textarea' ? '<textarea class="item-field" data-field-id="' + field.id + '" rows="3" placeholder="Completa este campo...">' + esc(value) + '</textarea>' :
      '<input class="item-field" data-field-id="' + field.id + '" type="' + (field.type === 'number' || field.type === 'date' || field.type === 'url' ? field.type : 'text') + '" value="' + esc(value) + '" placeholder="Completa este campo...">';
    return '<div class="form-group"><label>' + esc(field.label) + '</label>' + control + '</div>';
  }).join('');
}

function readItemFields() {
  var values = {};
  document.querySelectorAll('.item-field').forEach(function(input) { values[input.dataset.fieldId] = input.value.trim(); });
  return values;
}

function apiValueToText(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(apiValueToText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (value.name !== undefined) return apiValueToText(value.name);
    if (value.title !== undefined) return apiValueToText(value.title);
    if (value.description !== undefined) return apiValueToText(value.description);
    return Object.keys(value).map(function(key) { return apiValueToText(value[key]); }).filter(Boolean).join(', ');
  }
  return String(value);
}

function collectApiImages(raw, preferredPath) {
  var urls = [];
  function add(value) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value) && /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(value)) {
      if (urls.indexOf(value) === -1) urls.push(value);
    }
  }
  add(valueAtPath(raw, preferredPath));
  ['images', 'image', 'cover', 'poster', 'thumbnail', 'avatar', 'photo'].forEach(function(key) {
    var value = raw && raw[key];
    if (Array.isArray(value)) value.forEach(function(entry) { add(entry); if (entry && typeof entry === 'object') add(entry.url || entry.href || entry.src); });
    else if (value && typeof value === 'object') add(value.url || value.href || value.src);
    else add(value);
  });
  return urls;
}

async function uploadRemoteImage(url, publicId, folder) {
  if (!url || !/^https?:\/\//i.test(url)) return url;
  try {
    var formData = new FormData();
    formData.append('file', url);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    formData.append('public_id', publicId);
    formData.append('folder', folder);
    var response = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD_NAME + '/image/upload', { method: 'POST', body: formData });
    if (!response.ok) throw new Error('Cloudinary HTTP ' + response.status);
    var result = await response.json();
    return result.secure_url || url;
  } catch (error) {
    console.warn('No se pudo copiar la imagen a Cloudinary:', url, error);
    return url;
  }
}

function valueAtPath(value, path) {
  if (!path) return value;
  return path.split('.').filter(Boolean).reduce(function(current, key) {
    if (current === null || current === undefined) return undefined;
    var match = key.match(/^([^\[]+)(?:\[(\d+)\])?$/);
    if (!match) return undefined;
    current = current[match[1]];
    return match[2] !== undefined && Array.isArray(current) ? current[Number(match[2])] : current;
  }, value);
}

function apiMappingRow(mapping) {
  mapping = mapping || { source: '', label: '', type: 'text' };
  return '<div class="api-mapping-row">' +
    '<input class="api-source" value="' + esc(mapping.source) + '" placeholder="Ruta JSON: description">' +
    '<input class="api-label" value="' + esc(mapping.label) + '" placeholder="Título del campo">' +
    '<select class="api-type"><option value="text"' + (mapping.type === 'text' ? ' selected' : '') + '>Texto</option><option value="textarea"' + (mapping.type === 'textarea' ? ' selected' : '') + '>Texto largo</option><option value="number"' + (mapping.type === 'number' ? ' selected' : '') + '>Número</option><option value="date"' + (mapping.type === 'date' ? ' selected' : '') + '>Fecha</option><option value="url"' + (mapping.type === 'url' ? ' selected' : '') + '>Enlace</option></select>' +
    '<button class="field-delete api-delete" type="button">×</button></div>';
}

function collectApiMappings() {
  return Array.from(document.querySelectorAll('.api-mapping-row')).map(function(row) {
    return { source: row.querySelector('.api-source').value.trim(), label: row.querySelector('.api-label').value.trim(), type: row.querySelector('.api-type').value };
  }).filter(function(mapping) { return mapping.source && mapping.label; });
}

function prettyFieldLabel(key) {
  return key.split('.').pop().replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, function(letter) { return letter.toUpperCase(); });
}

function inferApiConfig(sample) {
  var fields = [];
  var namePath = '';
  var imagePath = '';
  var tagsPath = '';
  var ignored = /^(image|cover|poster|thumbnail|avatar|photo)$/i;
  function walk(value, path, depth) {
    if (!value || typeof value !== 'object' || depth > 5) return;
    Object.keys(value).forEach(function(key) {
      var nextPath = path ? path + '.' + key : key;
      var child = value[key];
      var lower = key.toLowerCase();
      if (!namePath && /^(name|title|label|display_name)$/i.test(key) && (typeof child === 'string' || typeof child === 'number')) namePath = nextPath;
      if (!imagePath && /(image|cover|poster|thumbnail|avatar|photo)/i.test(lower)) {
        if (typeof child === 'string') imagePath = nextPath;
        else if (child && typeof child.url === 'string') imagePath = nextPath + '.url';
      }
      if (!tagsPath && /^(tags?|genres?|categories?|types?)$/i.test(key) && (Array.isArray(child) || typeof child === 'string')) tagsPath = nextPath;
      if (child === null || child === undefined || typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean' || child instanceof Date) {
        if (!ignored.test(key) && nextPath !== namePath && nextPath !== imagePath && nextPath !== tagsPath) fields.push({ source: nextPath, label: prettyFieldLabel(key), type: typeof child === 'number' ? 'number' : 'text' });
      } else if (Array.isArray(child) && child.every(function(entry) { return typeof entry === 'string' || typeof entry === 'number'; })) {
        if (!ignored.test(key) && nextPath !== tagsPath) fields.push({ source: nextPath, label: prettyFieldLabel(key), type: 'text' });
      } else if (Array.isArray(child) && child[0] && typeof child[0] === 'object') {
        walk(child[0], nextPath + '[0]', depth + 1);
      } else if (child && typeof child === 'object' && !Array.isArray(child)) {
        walk(child, nextPath, depth + 1);
      }
    });
  }
  walk(sample, '', 0);
  return { namePath: namePath || 'name', imagePath: imagePath, tagsPath: tagsPath, mappings: fields.filter(function(field, index, list) { return list.findIndex(function(other) { return other.source === field.source; }) === index; }) };
}

function applyApiAutoConfig(sample) {
  var config = inferApiConfig(sample);
  document.getElementById('apiNamePath').value = config.namePath;
  document.getElementById('apiImagePath').value = config.imagePath;
  document.getElementById('apiTagsPath').value = config.tagsPath;
  document.getElementById('apiMappings').innerHTML = config.mappings.map(apiMappingRow).join('');
}

function apiConfigKey(preset, url) {
  return preset ? 'preset:' + preset : 'url:' + (url || '').trim();
}

function restoreApiConfig(preset, url) {
  var saved = data.apiConfigs[apiConfigKey(preset, url)];
  if (!saved) return false;
  document.getElementById('apiUrl').value = saved.url || url || '';
  document.getElementById('apiCollectionPath').value = saved.collection || '';
  document.getElementById('apiNamePath').value = saved.name || 'name';
  document.getElementById('apiImagePath').value = saved.image || '';
  document.getElementById('apiTagsPath').value = saved.tags || '';
  document.getElementById('apiFetchDetails').checked = !!saved.fetchDetails;
  document.getElementById('apiUploadImages').checked = saved.uploadImages !== false;
  document.getElementById('apiAutoFields').checked = false;
  document.getElementById('apiMappings').innerHTML = (saved.mappings || []).map(apiMappingRow).join('');
  if (saved.listName) document.getElementById('apiListName').value = saved.listName;
  apiConfigRestored = true;
  return true;
}

function updateApiConfigCopyButton() {
  var button = document.getElementById('btnCopyApiConfig');
  if (!button) return;
  var preset = document.getElementById('apiPreset').value;
  var url = document.getElementById('apiUrl').value.trim();
  button.disabled = !data.apiConfigs[apiConfigKey(preset, url)];
}

function saveCurrentApiConfig() {
  var preset = document.getElementById('apiPreset').value;
  var url = document.getElementById('apiUrl').value.trim();
  if (!url) return;
  data.apiConfigs[apiConfigKey(preset, url)] = {
    url: url,
    collection: document.getElementById('apiCollectionPath').value.trim(),
    name: document.getElementById('apiNamePath').value.trim(),
    image: document.getElementById('apiImagePath').value.trim(),
    tags: document.getElementById('apiTagsPath').value.trim(),
    fetchDetails: document.getElementById('apiFetchDetails').checked,
    uploadImages: document.getElementById('apiUploadImages').checked,
    mappings: collectApiMappings(),
    listName: document.getElementById('apiListName').value.trim(),
    savedAt: new Date().toISOString()
  };
  saveData();
}

function openApiImporterModal() {
  currentModal = 'apiImport'; currentSeriesId = null; apiPreviewData = null; apiConfigRestored = false;
  document.getElementById('modalTitle').textContent = 'Importar datos desde API';
  document.getElementById('btnSave').textContent = 'Importar lista';
  document.getElementById('modalBody').innerHTML =
    '<p class="modal-help">Solo se importarán los campos que configures. Usa rutas con puntos, por ejemplo <code>data.results</code>.</p>' +
    '<div class="form-group"><label>Fuente preestablecida</label><select id="apiPreset"><option value="">API personalizada</option><option value="digimon">Digimon API</option></select><button class="btn btn-ghost btn-sm api-copy-config" id="btnCopyApiConfig" type="button" disabled>Copiar configuración anterior</button></div>' +
    '<div class="form-group"><label>URL del endpoint</label><input id="apiUrl" type="url" placeholder="https://ejemplo.com/api/items"></div>' +
    '<div class="form-group"><label>Lista de destino</label><select id="apiTargetList"><option value="__new__">Crear una nueva lista</option>' + data.series.map(function(list) { return '<option value="' + esc(list.id) + '">' + esc(list.name) + '</option>'; }).join('') + '</select></div>' +
    '<div class="form-group"><label>Nombre de la lista nueva</label><input id="apiListName" placeholder="Mi colección"></div>' +
    '<div class="form-group"><label>Ruta de la colección</label><input id="apiCollectionPath" placeholder="data.results (vacío si la respuesta es un array)"></div>' +
    '<div class="form-group"><label>Ruta del nombre del item</label><input id="apiNamePath" value="name" placeholder="name"></div>' +
    '<div class="form-group"><label>Ruta de la imagen (opcional)</label><input id="apiImagePath" placeholder="image.url o image"></div>' +
    '<div class="form-group"><label>Ruta de tags (opcional)</label><input id="apiTagsPath" placeholder="genres"></div>' +
    '<label class="api-auto-toggle"><input id="apiFetchDetails" type="checkbox"> Cargar el detalle completo de cada resultado <span title="Puede realizar muchas solicitudes">ⓘ</span></label>' +
    '<label class="api-auto-toggle"><input id="apiUploadImages" type="checkbox" checked> Copiar imágenes a Cloudinary</label>' +
    '<label class="api-auto-toggle"><input id="apiAutoFields" type="checkbox" checked> Detectar todos los campos automáticamente</label>' +
    '<div class="api-fields-heading"><label>Campos adicionales</label><button class="btn btn-ghost btn-sm" id="btnAddApiField">+ Campo</button></div>' +
    '<div id="apiMappings">' + apiMappingRow({ source: 'description', label: 'Descripción', type: 'textarea' }) + '</div>' +
    '<button class="btn btn-ghost api-preview-btn" id="btnApiPreview">Probar conexión y previsualizar</button>' +
    '<div class="api-preview" id="apiPreview"></div>';
  document.getElementById('btnAddApiField').addEventListener('click', function() { document.getElementById('apiMappings').insertAdjacentHTML('beforeend', apiMappingRow()); });
  document.getElementById('apiPreset').addEventListener('change', function() {
    var preset = API_PRESETS[this.value];
    apiConfigRestored = false;
    if (!preset) return;
    document.getElementById('apiUrl').value = preset.url;
    document.getElementById('apiCollectionPath').value = preset.collection;
    document.getElementById('apiNamePath').value = preset.name;
    document.getElementById('apiImagePath').value = preset.image;
    document.getElementById('apiTagsPath').value = preset.tags;
    document.getElementById('apiMappings').innerHTML = preset.mappings.map(apiMappingRow).join('');
    document.getElementById('apiListName').value = preset.label;
    updateApiConfigCopyButton();
  });
  document.getElementById('apiUrl').addEventListener('change', function() {
    updateApiConfigCopyButton();
  });
  document.getElementById('btnCopyApiConfig').addEventListener('click', function() {
    var preset = document.getElementById('apiPreset').value;
    var url = document.getElementById('apiUrl').value.trim();
    if (!restoreApiConfig(preset, url)) return alert('Todavía no hay una configuración anterior para esta API.');
  });
  document.getElementById('btnApiPreview').addEventListener('click', previewApiImport);
  document.getElementById('apiTargetList').addEventListener('change', function() {
    document.getElementById('apiListName').disabled = this.value !== '__new__';
  });
  document.getElementById('modal').classList.add('active');
}

async function previewApiImport() {
  var url = document.getElementById('apiUrl').value.trim();
  var preview = document.getElementById('apiPreview');
  if (!url) return alert('Escribe la URL de la API');
  saveCurrentApiConfig();
  preview.textContent = 'Consultando API...';
  try {
    var response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var json = await response.json();
    var collection = valueAtPath(json, document.getElementById('apiCollectionPath').value.trim());
    if (!Array.isArray(collection)) throw new Error('La ruta no contiene una colección (array)');
    if (document.getElementById('apiFetchDetails').checked) {
      var detailResults = await Promise.all(collection.map(async function(item) {
        var detailUrl = item.href || item.url;
        if (!detailUrl) return item;
        var detailResponse = await fetch(detailUrl);
        return detailResponse.ok ? await detailResponse.json() : item;
      }));
      collection = detailResults;
      if (document.getElementById('apiAutoFields').checked && collection[0]) applyApiAutoConfig(collection[0]);
    }
    apiPreviewData = { json: json, collection: collection, mappings: collectApiMappings() };
    if (document.getElementById('apiAutoFields').checked && collection[0]) applyApiAutoConfig(collection[0]);
    apiPreviewData.mappings = collectApiMappings();
    saveCurrentApiConfig();
    preview.innerHTML = '<strong>Conexión correcta:</strong> ' + collection.length + ' items encontrados.<br><span>' + collection.slice(0, 3).map(function(item) { return esc(String(valueAtPath(item, document.getElementById('apiNamePath').value.trim()) || 'Sin nombre')); }).join(' · ') + (collection.length > 3 ? ' · ...' : '') + '</span>';
  } catch (error) {
    apiPreviewData = null;
    preview.textContent = 'No se pudo leer la API: ' + error.message + '. Verifica la URL, la ruta y que permita CORS.';
  }
}

async function importApiData() {
  if (apiImporting) return;
  if (!apiPreviewData) return alert('Primero prueba la conexión y revisa la vista previa');
  var targetId = document.getElementById('apiTargetList').value;
  var targetList = targetId !== '__new__' ? data.series.find(function(list) { return list.id === targetId; }) : null;
  var name = targetList ? targetList.name : document.getElementById('apiListName').value.trim();
  var namePath = document.getElementById('apiNamePath').value.trim();
  var imagePath = document.getElementById('apiImagePath').value.trim();
  var tagsPath = document.getElementById('apiTagsPath').value.trim();
  if (!name || !namePath) return alert('Completa el nombre de la lista y la ruta del nombre');
  // Se usa la configuración capturada al previsualizar para que los campos
  // detectados no se pierdan entre la consulta y la importación.
  var mappings = apiPreviewData.mappings || collectApiMappings();
  var fields = mappings.map(function(mapping) {
    if (targetList) {
      var existing = (targetList.fields || []).find(function(field) { return field.source === mapping.source || String(field.label || '').toLowerCase() === String(mapping.label || '').toLowerCase(); });
      if (existing) return existing;
    }
    return { id: generateId(), label: mapping.label, type: mapping.type, source: mapping.source };
  });
  if (targetList) {
    if (!targetList.fields) targetList.fields = [];
    fields.forEach(function(field) { if (!targetList.fields.some(function(existing) { return existing.id === field.id; })) targetList.fields.push(field); });
  }
  apiImporting = true;
  document.getElementById('btnSave').disabled = true;
  var uploadImages = document.getElementById('apiUploadImages').checked;
  document.getElementById('btnSave').textContent = uploadImages ? 'Copiando imágenes...' : 'Importando...';
  var targetFolder = sanitizePublicId(name) || 'multibestiario';
  var items = [];
  for (var index = 0; index < apiPreviewData.collection.length; index++) {
    var raw = apiPreviewData.collection[index];
    var tags = valueAtPath(raw, tagsPath);
    if (!Array.isArray(tags)) tags = tags ? String(tags).split(',') : [];
    var images = collectApiImages(raw, imagePath);
    var itemName = apiValueToText(valueAtPath(raw, namePath)) || 'Sin nombre';
    var uploadedImages = [];
    for (var imageIndex = 0; imageIndex < images.length; imageIndex++) {
      uploadedImages.push(uploadImages ? await uploadRemoteImage(images[imageIndex], sanitizePublicId(itemName) + '_' + (imageIndex + 1), targetFolder) : images[imageIndex]);
    }
    document.getElementById('apiPreview').textContent = (uploadImages ? 'Copiando imágenes: ' : 'Importando: ') + (index + 1) + ' / ' + apiPreviewData.collection.length;
    items.push({ id: generateId(), name: itemName, alias: '', image: uploadedImages[0] || '', images: uploadedImages, checked: false, tags: tags.map(function(tag) { return apiValueToText(tag).trim().toLowerCase(); }).filter(Boolean), values: Object.fromEntries(fields.map(function(field) { return [field.id, apiValueToText(valueAtPath(raw, field.source))]; })) });
  }
  if (targetList) {
    targetList.characters = (targetList.characters || []).concat(items);
    targetList._open = true;
  } else {
    data.series.push({ id: generateId(), name: name, cover: items[0] ? items[0].image : '', folderId: currentFolderId || null, description: '', characters: items, fields: fields, checkLabel: 'Check', tags: [], _open: true });
  }
  saveData(); apiPreviewData = null; apiImporting = false; document.getElementById('btnSave').disabled = false; document.getElementById('btnSave').textContent = 'Guardar'; renderHome(); closeModal();
  alert('Importados ' + items.length + ' items en "' + name + '"');
}

/* ===== MODALS ===== */
function openModal(type, seriesId) {
  currentModal = type;
  currentSeriesId = seriesId || null;
  currentCharId = null;
  tempImageUrl = null;
  tempCoverUrl = null;
  var modal = document.getElementById('modal');
  var title = document.getElementById('modalTitle');
  var body = document.getElementById('modalBody');
  document.getElementById('btnSave').textContent = 'Guardar';

  modal.classList.add('active');

  if (type === 'series') {
    title.textContent = 'Nueva Lista';
    body.innerHTML =
      '<div class="form-group"><label>Nombre de la lista</label><input type="text" id="inputName" placeholder="Ej: Attack on Titan" autofocus></div>' +
      '<div class="form-group"><label>Portada</label><input type="file" id="inputCover" accept="image/*"><div class="img-preview" id="coverPreview" style="aspect-ratio:3/4;"><span style="font-size:14px;">Toca para subir portada</span></div><div class="upload-status" id="coverStatus"></div></div>' +
      '<div class="form-group"><label>Tags (opcional)</label><input type="text" id="inputSeriesTags" placeholder="shonen, accion, fantasia..."></div>' +
      '<div class="form-group"><label>Carpeta</label><select id="inputFolder">' + folderOptionsHtml(currentFolderId || '', null) + '</select></div>';

    document.getElementById('coverPreview').addEventListener('click', function() { document.getElementById('inputCover').click(); });
    document.getElementById('inputCover').addEventListener('change', function() { handleCoverSelect(this); });
    setTimeout(function() { document.getElementById('inputName').focus(); }, 100);
  } else {
    var parentList = data.series.find(function(x) { return x.id === currentSeriesId; });
    title.textContent = 'Nuevo Item';
    body.innerHTML =
      '<div class="form-group"><label>Título / nombre</label><input type="text" id="inputCharName" placeholder="Ej: Eren Yeager" autofocus></div>' +
      '<div class="form-group"><label>Alias / Apodo (opcional)</label><input type="text" id="inputCharAlias" placeholder="Ej: Titan de Ataque"></div>' +
      '<div class="form-group"><label>Tags (opcional)</label><input type="text" id="inputCharTags" placeholder="protagonista, titan, favorito..."></div>' +
      itemFieldsHtml(parentList || { fields: [] }, null) +
      '<div class="form-group"><label>Imagen (opcional)</label><input type="file" id="inputImage" accept="image/*"><div class="img-preview" id="imgPreview"><span style="font-size:14px;">Toca para seleccionar imagen</span></div><div class="upload-status" id="uploadStatus"></div></div>';

    document.getElementById('imgPreview').addEventListener('click', function() { document.getElementById('inputImage').click(); });
    document.getElementById('inputImage').addEventListener('change', function() { handleImageSelect(this); });
    setTimeout(function() { document.getElementById('inputCharName').focus(); }, 100);
  }
}

function openEditSeriesModal(seriesId) {
  var s = data.series.find(function(x) { return x.id === seriesId; });
  currentModal = 'editSeries';
  currentSeriesId = seriesId;
  currentCharId = null;
  tempCoverUrl = s.cover || null;
  var modal = document.getElementById('modal');
  var title = document.getElementById('modalTitle');
  var body = document.getElementById('modalBody');

  modal.classList.add('active');
  title.textContent = 'Editar Serie';
  body.innerHTML =
    '<div class="form-group"><label>Nombre de la serie</label><input type="text" id="editName" value="' + esc(s.name) + '" autofocus></div>' +
    '<div class="form-group"><label>Texto de la portada (opcional)</label><textarea id="editDescription" rows="3" placeholder="Una descripción breve para esta lista...">' + esc(s.description || '') + '</textarea></div>' +
    '<div class="form-group"><label>Portada</label><input type="file" id="editCover" accept="image/*"><div class="img-preview" id="coverPreview" style="aspect-ratio:3/4;">' + (s.cover ? '<img src="' + s.cover + '">' : '<span style="font-size:14px;">Toca para cambiar portada</span>') + '</div><div class="upload-status" id="coverStatus"></div></div>' +
    '<div class="form-group"><label>Tags</label><input type="text" id="editSeriesTags" value="' + esc(s.tags.join(', ')) + '" placeholder="shonen, accion, fantasia..."></div>';

  document.getElementById('coverPreview').addEventListener('click', function() { document.getElementById('editCover').click(); });
  document.getElementById('editCover').addEventListener('change', function() { handleCoverSelect(this, true); });
  setTimeout(function() { document.getElementById('editName').focus(); }, 100);
}

function openEditCharModal(seriesId, charId) {
  var s = data.series.find(function(x) { return x.id === seriesId; });
  var c = s.characters.find(function(x) { return x.id === charId; });
  currentModal = 'editCharacter';
  currentSeriesId = seriesId;
  currentCharId = charId;
  tempImageUrl = c.image || null;
  var itemImages = (c.images && c.images.length ? c.images.slice() : []);
  if (c.image && itemImages.indexOf(c.image) === -1) itemImages.unshift(c.image);
  var modal = document.getElementById('modal');
  var title = document.getElementById('modalTitle');
  var body = document.getElementById('modalBody');

  modal.classList.add('active');
  title.textContent = 'Editar Personaje';
  body.innerHTML =
    '<div class="form-group"><label>Nombre</label><input type="text" id="editCharName" value="' + esc(c.name) + '" autofocus></div>' +
    '<div class="form-group"><label>Alias / Apodo</label><input type="text" id="editCharAlias" value="' + esc(c.alias || '') + '" placeholder="Ej: Titan de Ataque"></div>' +
    '<div class="form-group"><label>Tags</label><input type="text" id="editCharTags" value="' + esc(c.tags.join(', ')) + '" placeholder="protagonista, titan, favorito..."></div>' +
    itemFieldsHtml(s, c) +
    '<div class="form-group"><label>Imagen de portada del item</label><input type="file" id="editImage" accept="image/*"><div class="img-preview" id="imgPreview">' + (c.image ? '<img src="' + c.image + '">' : '<span style="font-size:14px;">Toca para cambiar imagen</span>') + '</div>' +
    (itemImages.length > 1 ? '<div class="item-image-choices"><div class="image-choice-label">Elegir portada</div>' + itemImages.map(function(image, index) { return '<label class="image-choice"><input type="radio" name="itemCoverChoice" value="' + esc(image) + '"' + (image === c.image || (!c.image && index === 0) ? ' checked' : '') + '><img src="' + esc(image) + '" alt="Imagen ' + (index + 1) + '"></label>'; }).join('') + '</div>' : '') +
    '<div class="upload-status" id="uploadStatus"></div></div>';

  document.getElementById('imgPreview').addEventListener('click', function() { document.getElementById('editImage').click(); });
  document.getElementById('editImage').addEventListener('change', function() { handleImageSelect(this, true); });
  body.querySelectorAll('input[name="itemCoverChoice"]').forEach(function(input) {
    input.addEventListener('change', function() {
      tempImageUrl = this.value;
      document.getElementById('imgPreview').innerHTML = '<img src="' + esc(tempImageUrl) + '">';
    });
  });
  setTimeout(function() { document.getElementById('editCharName').focus(); }, 100);
}

function closeModal() {
  document.getElementById('modal').classList.remove('active');
  currentModal = null;
  currentSeriesId = null;
  currentCharId = null;
  tempImageUrl = null;
  tempCoverUrl = null;
}

function saveModal() {
  if (currentModal === 'apiImport') {
    importApiData();
  }
  else if (currentModal === 'style') {
    var styleList = data.series.find(function(x) { return x.id === currentSeriesId; });
    if (!styleList) return;
    styleList.layout = collectListLayout();
    saveData();
    renderSerieDetail(currentSeriesId);
    renderItemDetail(currentSeriesId, currentItemId);
    showPage(currentItemId ? 'pageItem' : 'pageSerie');
    closeModal();
  }
  else if (currentModal === 'series') {
    var name = document.getElementById('inputName').value.trim();
    var tagsStr = document.getElementById('inputSeriesTags') ? document.getElementById('inputSeriesTags').value.trim() : '';
    if (!name) return alert('Escribe un nombre');
    var tags = tagsStr.split(',').map(function(t) { return t.trim().toLowerCase(); }).filter(function(t) { return t; });
    tags.forEach(addToAllTags);
    data.series.push({
      id: generateId(), name: name, cover: tempCoverUrl || '', folderId: (document.getElementById('inputFolder') || {}).value || null,
      description: '', characters: [], fields: [{ id: generateId(), label: 'Descripción', type: 'textarea' }], checkLabel: 'Check', tags: tags, _open: true
    });
    saveData();
    renderHome();
    closeModal();
  }
  else if (currentModal === 'character') {
    var name = document.getElementById('inputCharName').value.trim();
    var alias = document.getElementById('inputCharAlias').value.trim();
    var tagsStr = document.getElementById('inputCharTags') ? document.getElementById('inputCharTags').value.trim() : '';
    if (!name) return alert('Escribe un nombre');
    var tags = tagsStr.split(',').map(function(t) { return t.trim().toLowerCase(); }).filter(function(t) { return t; });
    tags.forEach(addToAllTags);

    var s = data.series.find(function(x) { return x.id === currentSeriesId; });
    s.characters.push({
      id: generateId(), name: name, alias: alias, image: tempImageUrl || '', images: tempImageUrl ? [tempImageUrl] : [], checked: false, tags: tags, values: readItemFields()
    });
    saveData();
    renderSerieDetail(currentSeriesId);
    closeModal();
  }
  else if (currentModal === 'fields') {
    var list = data.series.find(function(x) { return x.id === currentSeriesId; });
    if (!list) return;
    list.fields = collectFields();
    list.characters.forEach(function(item) { if (!item.values) item.values = {}; });
    saveData(); renderSerieDetail(currentSeriesId); closeModal();
  }
  else if (currentModal === 'editSeries') {
    var s = data.series.find(function(x) { return x.id === currentSeriesId; });
    var name = document.getElementById('editName').value.trim();
    var tagsStr = document.getElementById('editSeriesTags') ? document.getElementById('editSeriesTags').value.trim() : '';
    if (!name) return alert('Escribe un nombre');

    s.name = name;
    s.description = document.getElementById('editDescription') ? document.getElementById('editDescription').value.trim() : (s.description || '');
    s.tags = tagsStr.split(',').map(function(t) { return t.trim().toLowerCase(); }).filter(function(t) { return t; });
    s.tags.forEach(addToAllTags);
    if (tempCoverUrl !== null) s.cover = tempCoverUrl;

    saveData();
    renderHome();
    renderSerieDetail(currentSeriesId);
    closeModal();
  }
  else if (currentModal === 'editCharacter') {
    var s = data.series.find(function(x) { return x.id === currentSeriesId; });
    var c = s.characters.find(function(x) { return x.id === currentCharId; });
    var name = document.getElementById('editCharName').value.trim();
    var alias = document.getElementById('editCharAlias').value.trim();
    var tagsStr = document.getElementById('editCharTags') ? document.getElementById('editCharTags').value.trim() : '';
    if (!name) return alert('Escribe un nombre');

    c.name = name;
    c.alias = alias;
    c.tags = tagsStr.split(',').map(function(t) { return t.trim().toLowerCase(); }).filter(function(t) { return t; });
    c.values = readItemFields();
    c.tags.forEach(addToAllTags);
    if (tempImageUrl !== null) {
      c.image = tempImageUrl;
      c.images = c.images && c.images.length ? c.images : (c.image ? [c.image] : []);
      if (c.image && c.images.indexOf(c.image) === -1) c.images.unshift(c.image);
    }

    saveData();
    renderSerieDetail(currentSeriesId);
    if (currentItemId === currentCharId) {
      renderItemDetail(currentSeriesId, currentItemId);
      showPage('pageItem');
    }
    closeModal();
  }
  else if (currentModal === 'moveItem') {
    var source = data.series.find(function(list) { return list.id === currentSeriesId; });
    var destination = data.series.find(function(list) { return list.id === document.getElementById('moveItemTarget').value; });
    if (!source || !destination || source.id === destination.id) return;
    var itemIndex = source.characters.findIndex(function(item) { return item.id === currentCharId; });
    if (itemIndex < 0) return;
    var item = source.characters.splice(itemIndex, 1)[0];
    // Las listas comparten la ficha visual, pero sus campos pueden tener IDs distintos.
    // Se agregan al destino los campos que no existan y se remapean los valores.
    var sourceFields = source.fields || [];
    var destinationFields = destination.fields || (destination.fields = []);
    var remappedValues = {};
    sourceFields.forEach(function(sourceField) {
      var destinationField = destinationFields.find(function(field) {
        return (sourceField.source && field.source === sourceField.source) || String(field.label || '').toLowerCase() === String(sourceField.label || '').toLowerCase();
      });
      if (!destinationField) {
        destinationField = Object.assign({}, sourceField, { id: generateId() });
        destinationFields.push(destinationField);
      }
      if (item.values && item.values[sourceField.id] !== undefined) remappedValues[destinationField.id] = item.values[sourceField.id];
    });
    item.values = remappedValues;
    destination.characters = destination.characters || [];
    destination.characters.push(item);
    saveData();
    goToSerie(source.id);
    closeModal();
  }
}

/* ===== CLOUDINARY ===== */
async function uploadToCloudinary(file, previewId, statusId, publicId, folder) {
  var preview = document.getElementById(previewId);
  var status = document.getElementById(statusId);

  var reader = new FileReader();
  reader.onload = function(e) { preview.innerHTML = '<img src="' + e.target.result + '">'; };
  reader.readAsDataURL(file);

  status.textContent = 'Subiendo a Cloudinary...';
  status.style.color = 'var(--text-secondary)';

  try {
    var formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    if (publicId) formData.append('public_id', publicId);
    if (folder) formData.append('folder', folder);

    var res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD_NAME + '/image/upload', {
      method: 'POST', body: formData
    });

    if (!res.ok) throw new Error('Error al subir');
    var json = await res.json();
    status.textContent = 'Imagen lista';
    status.style.color = 'var(--accent)';
    return json.secure_url;
  } catch (err) {
    status.textContent = 'Error al subir. Revisa que el upload preset este en modo Unsigned.';
    status.style.color = 'var(--danger)';
    console.error(err);
    return null;
  }
}

async function handleCoverSelect(input, isEdit) {
  var file = input.files[0];
  if (!file) return;
  var nameInput = document.getElementById(isEdit ? 'editName' : 'inputName');
  var seriesName = nameInput ? nameInput.value.trim() : 'serie';
  var folder = sanitizePublicId(seriesName);
  tempCoverUrl = await uploadToCloudinary(file, 'coverPreview', 'coverStatus', 'cover', folder);
}

async function handleImageSelect(input, isEdit) {
  var file = input.files[0];
  if (!file) return;
  var nameInput = document.getElementById(isEdit ? 'editCharName' : 'inputCharName');
  var aliasInput = document.getElementById(isEdit ? 'editCharAlias' : 'inputCharAlias');
  var charName = nameInput ? nameInput.value.trim() : 'personaje';
  var charAlias = aliasInput ? aliasInput.value.trim() : '';
  var seriesName = currentSeriesId
    ? (data.series.find(function(x) { return x.id === currentSeriesId; })?.name || 'serie')
    : 'serie';

  var folder = sanitizePublicId(seriesName);
  var publicId = sanitizePublicId(charName);
  if (charAlias) publicId += '_' + sanitizePublicId(charAlias);

  tempImageUrl = await uploadToCloudinary(file, 'imgPreview', 'uploadStatus', publicId, folder);
}

/* ===== POKEAPI ===== */
function setProgress(current, total, text) {
  var fill = document.getElementById('progressFill');
  var txt = document.getElementById('progressText');
  var bar = document.getElementById('importProgress');
  if (!fill) return;
  bar.classList.add('active');
  var pct = total > 0 ? Math.round((current / total) * 100) : 0;
  fill.style.width = pct + '%';
  txt.textContent = text || (current + ' / ' + total);
}

function hideProgress() {
  var bar = document.getElementById('importProgress');
  if (bar) bar.classList.remove('active');
}

async function fetchPokemonSpecies(id) {
  if (pokeCache['species_' + id]) return pokeCache['species_' + id];
  try {
    var res = await fetch('https://pokeapi.co/api/v2/pokemon-species/' + id);
    if (!res.ok) return null;
    var data = await res.json();
    pokeCache['species_' + id] = data;
    savePokeCache();
    return data;
  } catch (e) { return null; }
}

async function fetchPokemon(id) {
  if (pokeCache['pokemon_' + id]) return pokeCache['pokemon_' + id];
  try {
    var res = await fetch('https://pokeapi.co/api/v2/pokemon/' + id);
    if (!res.ok) return null;
    var data = await res.json();
    pokeCache['pokemon_' + id] = data;
    savePokeCache();
    return data;
  } catch (e) { return null; }
}

function getSpanishName(speciesData) {
  if (!speciesData || !speciesData.names) return null;
  var es = speciesData.names.find(function(n) { return n.language.name === 'es'; });
  return es ? es.name : null;
}

function getEnglishName(speciesData) {
  if (!speciesData || !speciesData.names) return null;
  var en = speciesData.names.find(function(n) { return n.language.name === 'en'; });
  return en ? en.name : null;
}

async function importPokemonGeneration(key) {
  if (isImporting) return alert('Ya hay una importacion en curso');
  var config = POKEAPI_RANGES[key];
  if (!config) return;

  isImporting = true;
  closeSidebar();

  var existing = data.series.find(function(s) { return s.name === config.name; });
  if (existing) {
    if (!confirm('La serie "' + config.name + '" ya existe. Quieres reemplazarla?')) {
      isImporting = false;
      return;
    }
    data.series = data.series.filter(function(s) { return s.name !== config.name; });
  }

  var characters = [];
  var total = config.limit;

  for (var i = 0; i < config.limit; i++) {
    var pokemonId = config.offset + i + 1;
    setProgress(i, total, 'Cargando ' + pokemonId + ' / ' + (config.offset + total));

    var pokemon = await fetchPokemon(pokemonId);
    if (!pokemon) continue;

    var species = await fetchPokemonSpecies(pokemonId);
    var nameEs = getSpanishName(species);
    var nameEn = getEnglishName(species) || pokemon.name;
    var displayName = nameEs || nameEn;

    var types = pokemon.types.map(function(t) { return t.type.name; });
    var image = pokemon.sprites.other['official-artwork'].front_default || pokemon.sprites.front_default;

    characters.push({
      id: generateId(),
      name: displayName,
      alias: '#' + pokemonId,
      image: image,
      checked: false,
      tags: types
    });

    if (i % 10 === 0) await new Promise(function(r) { setTimeout(r, 300); });
  }

  var cover = '';
  if (characters.length > 0 && characters[0].image) {
    cover = characters[0].image;
  }

  data.series.push({
    id: generateId(),
    name: config.name,
    cover: cover,
    characters: characters,
    checkLabel: 'Check',
    tags: ['pokemon', key],
    _open: true
  });

  addToAllTags('pokemon');
  addToAllTags(key);
  saveData();
  hideProgress();
  isImporting = false;

  if (currentSeriesId) renderSerieDetail(currentSeriesId);
  else renderHome();

  alert('Importado: ' + characters.length + ' Pokemon en "' + config.name + '"');
}

/* ===== EXPORT / IMPORT JSON ===== */
function exportData() {
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'multibestiario_backup_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var imported = JSON.parse(e.target.result);
      if (imported.series && Array.isArray(imported.series)) {
        data = imported;
        if (!data.allTags) data.allTags = [];
        saveData();
        renderHome();
        alert('Datos importados correctamente');
      } else {
        alert('Archivo invalido');
      }
    } catch (err) {
      alert('Error al leer el archivo');
    }
  };
  reader.readAsText(file);
}

/* ===== EVENT LISTENERS ===== */
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('btnMenu').addEventListener('click', openSidebar);
  document.getElementById('btnCloseSidebar').addEventListener('click', closeSidebar);
  document.getElementById('sidebarOverlay').addEventListener('click', closeSidebar);

  document.getElementById('btnApiImport').addEventListener('click', function() {
    closeSidebar();
    openApiImporterModal();
  });

  document.getElementById('btnExport').addEventListener('click', function() {
    closeSidebar();
    exportData();
  });

  document.getElementById('btnImport').addEventListener('click', function() {
    closeSidebar();
    document.getElementById('importFileInput').click();
  });

  document.getElementById('importFileInput').addEventListener('change', function(e) {
    if (e.target.files[0]) importData(e.target.files[0]);
  });

  document.getElementById('btnAddSerie').addEventListener('click', function() { openModal('series'); });
  document.getElementById('btnAddFolder').addEventListener('click', createFolder);
  document.getElementById('homeSearch').addEventListener('input', renderHome);
  document.getElementById('btnCancel').addEventListener('click', closeModal);
  document.getElementById('btnSave').addEventListener('click', saveModal);
  document.getElementById('modal').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
    var fieldDelete = e.target.closest('.field-editor-row .field-delete');
    if (fieldDelete) fieldDelete.closest('.field-editor-row').remove();
    var apiDelete = e.target.closest('.api-mapping-row .api-delete');
    if (apiDelete) apiDelete.closest('.api-mapping-row').remove();
    var up = e.target.closest('.style-move-up');
    var down = e.target.closest('.style-move-down');
    if (up || down) {
      var row = (up || down).closest('.style-block-row');
      var sibling = up ? row.previousElementSibling : row.nextElementSibling;
      if (sibling) up ? sibling.before(row) : sibling.after(row);
    }
    if (e.target.closest('.style-delete')) e.target.closest('.style-block-row').remove();
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      closeModal();
      closeSidebar();
    }
  });

  // Swipe to open sidebar
  var touchStartX = 0;
  document.addEventListener('touchstart', function(e) {
    touchStartX = e.touches[0].clientX;
  });
  document.addEventListener('touchend', function(e) {
    var touchEndX = e.changedTouches[0].clientX;
    var diff = touchEndX - touchStartX;
    if (touchStartX < 30 && diff > 80) openSidebar();
  });

  // Init
  renderHome();
  initCloudSync();
});
