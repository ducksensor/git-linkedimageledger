// -------------------------------------------------- //
// Git-linked File Ledger Application Core Logic       //
// -------------------------------------------------- //

// データの永続化・保護機能
if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then(granted => {
        if (granted) console.log("Storage persistence granted.");
    });
}

// データベース設計 (IndexedDB: Dexie.js)
const db = new Dexie('GitImageLedgerDB');
db.version(1).stores({
    repositories: 'id, name, updatedAt',
    files: 'filename, repoId, sha256, createdAt',
    csv_meta: 'repoId, csvText'
});

// 状態管理 (State)
let gitHubToken = localStorage.getItem('github_token') || '';
let currentRepoId = null;
let pendingFile = null; 

// UI要素の参照
const loginScreen = document.getElementById('login-screen');
const mainDashboard = document.getElementById('main-dashboard');
const tokenInput = document.getElementById('github-token');
const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');

const repoListContainer = document.getElementById('repo-list');
const newRepoNameInput = document.getElementById('new-repo-name');
const btnCreateRepo = document.getElementById('btn-create-repo');

const btnTriggerImport = document.getElementById('btn-trigger-import');
const importZipInput = document.getElementById('import-zip-input');

const currentRepoTitle = document.getElementById('current-repo-title');
const currentRepoIdEl = document.getElementById('current-repo-id');
const btnExportZip = document.getElementById('btn-export-zip');
const repoContentArea = document.getElementById('repo-content-area');
const repoPlaceholder = document.getElementById('repo-placeholder');

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileTableBody = document.getElementById('file-table-body');

const noteModal = document.getElementById('note-modal');
const modalFilenamePreview = document.getElementById('modal-filename-preview');
const modalNoteText = document.getElementById('modal-note-text');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalSubmit = document.getElementById('btn-modal-submit');

// 初期化処理
window.addEventListener('DOMContentLoaded', () => {
    if (gitHubToken) {
        showDashboard();
    } else {
        showLogin();
    }
});

function showLogin() {
    loginScreen.classList.remove('hidden');
    mainDashboard.classList.add('hidden');
}

async function showDashboard() {
    loginScreen.classList.add('hidden');
    mainDashboard.classList.remove('hidden');
    tokenInput.value = gitHubToken;
    await refreshRepoList();
}

// GitHub認証機能
btnLogin.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    if (!token) return alert('GitHubアクセストークンを入力してください。');
    gitHubToken = token;
    localStorage.setItem('github_token', token);
    showDashboard();
});

btnLogout.addEventListener('click', () => {
    if (confirm('トークン情報を削除して切断しますか？')) {
        localStorage.removeItem('github_token');
        gitHubToken = '';
        currentRepoId = null;
        showLogin();
    }
});

// GitHub API 共通リクエスト関数
async function fetchGitHubAPI(endpoint, method = 'GET', body = null) {
    const headers = {
        'Authorization': `token ${gitHubToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
    };
    const config = { method, headers };
    if (body) config.body = JSON.stringify(body);

    const response = await fetch(`https://api.github.com${endpoint}`, config);
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.message || `API Error: ${response.status}`);
    }
    return response.json();
}

async function getGitHubUser() {
    return await fetchGitHubAPI('/user');
}

// 各リポジトリの IndexedDB 内データサイズを計算するヘルパー関数
async function getRepoSizeString(repoId) {
    let totalBytes = 0;

    // 格納されているファイル(Blob)のサイズを高速走査集計
    await db.files.where('repoId').equals(repoId).each(file => {
        if (file.fileData && file.fileData.size) {
            totalBytes += file.fileData.size;
        }
    });

    // 管理用メタデータCSVのサイズも集計に付加
    const meta = await db.csv_meta.get(repoId);
    if (meta && meta.csvText) {
        totalBytes += new Blob([meta.csvText]).size;
    }

    if (totalBytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(totalBytes) / Math.log(k));
    return parseFloat((totalBytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// リポジトリ新規作成機能
btnCreateRepo.addEventListener('click', async () => {
    const repoName = newRepoNameInput.value.trim();
    if (!repoName) return alert('リポジトリ名を入力してください。');

    btnCreateRepo.disabled = true;
    btnCreateRepo.innerText = '作成中...';

    try {
        const user = await getGitHubUser();
        const owner = user.login;
        const repoId = `${owner}/${repoName}`;

        await fetchGitHubAPI('/user/repos', 'POST', {
            name: repoName,
            private: true,
            auto_init: false
        });

        const initialCSV = "timestamp(jst),filename,sha256,note\n";
        const base64Content = btoa(unescape(encodeURIComponent(initialCSV)));
        await fetchGitHubAPI(`/repos/${repoId}/contents/data.csv`, 'PUT', {
            message: "Initial commit with empty data.csv",
            content: base64Content
        });

        const nowStr = new Date().toLocaleString('ja-JP');
        await db.repositories.add({ id: repoId, name: repoName, updatedAt: nowStr });
        await db.csv_meta.add({ repoId: repoId, csvText: initialCSV });

        alert(`リポジトリ「${repoId}」の作成と初期同期が完了しました！`);
        newRepoNameInput.value = '';
        await refreshRepoList();
        await selectRepository(repoId);

    } catch (error) {
        console.error(error);
        alert(`リポジトリ作成に失敗しました: ${error.message}`);
    } finally {
        btnCreateRepo.disabled = false;
        btnCreateRepo.innerText = 'GitHub上に作成 & 同期';
    }
});

// バックアップZIPからのインポート機能
btnTriggerImport.addEventListener('click', () => importZipInput.click());
importZipInput.addEventListener('change', async (e) => {
    if (e.target.files.length === 0) return;
    const file = e.target.files[0];
    
    btnTriggerImport.disabled = true;
    btnTriggerImport.innerText = 'インポート中...';

    try {
        const zip = await JSZip.loadAsync(file);
        
        const metaFile = zip.file("meta.json");
        if (!metaFile) throw new Error("ZIP内に meta.json が見つかりません。有効なバックアップではありません。");
        
        const metaText = await metaFile.async("text");
        const meta = JSON.parse(metaText);
        const repoId = meta.repoId;
        const repoName = meta.repoName;

        if (!repoId || !repoName) throw new Error("meta.json のデータ構造が不正です。");

        if (!gitHubToken) throw new Error("GitHubアクセストークンが設定されていません。");
        
        try {
            await fetchGitHubAPI(`/repos/${repoId}`);
        } catch (err) {
            throw new Error(`GitHub上にリポジトリ「${repoId}」が存在しないか、アクセス権がありません。`);
        }

        const csvFile = zip.file("data.csv");
        if (!csvFile) throw new Error("ZIP内に data.csv が見つかりません。");
        const zipCsvText = await csvFile.async("text");

        let githubCsvText = "";
        try {
            const githubFileInfo = await fetchGitHubAPI(`/repos/${repoId}/contents/data.csv`);
            githubCsvText = decodeURIComponent(escape(atob(githubFileInfo.content)));
        } catch (err) {
            githubCsvText = "timestamp(jst),filename,sha256,note\n"; 
        }

        const countLines = (text) => text.trim().split('\n').filter(line => line.trim().length > 0).length;
        const zipLinesCount = countLines(zipCsvText);
        const githubLinesCount = countLines(githubCsvText);

        if (zipLinesCount !== githubLinesCount) {
            throw new Error(`CSVの行数が一致しません。同期を安全に保つためインポートを中断します。\n\nGitHubリモート側: ${githubLinesCount} 行\n選択したZIP内: ${zipLinesCount} 行`);
        }

        const timestampJst = formatDateJst(new Date());
        await db.repositories.put({ id: repoId, name: repoName, updatedAt: timestampJst });
        await db.csv_meta.put({ repoId: repoId, csvText: zipCsvText });

        const lines = zipCsvText.trim().split('\n');
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            
            const cols = line.split('","').map(c => c.replace(/^"|"$/g, ''));
            if (cols.length < 3) continue;
            
            const timestamp = cols[0];
            const filename = cols[1];
            const sha256 = cols[2];

            let zFile = zip.file(`raw_images/${filename}`) || zip.file(filename);

            if (zFile) {
                const blob = await zFile.async("blob");
                await db.files.put({
                    filename: filename,
                    repoId: repoId,
                    sha256: sha256,
                    fileData: blob,
                    createdAt: timestamp
                });
            }
        }

        alert(`リポジトリ「${repoId}」のローカルインポートが成功しました。`);
        await refreshRepoList();
        await selectRepository(repoId);

    } catch (error) {
        console.error(error);
        alert(`インポートに失敗しました:\n${error.message}`);
    } finally {
        btnTriggerImport.disabled = false;
        btnTriggerImport.innerText = '📁 ZIPファイルを選択';
        importZipInput.value = '';
    }
});

// リポジトリ一覧の描画 (サイズ計測および削除ボタン統合版)
async function refreshRepoList() {
    const repos = await db.repositories.toArray();
    repoListContainer.innerHTML = '';
    
    if (repos.length === 0) {
        repoListContainer.innerHTML = `<p class="text-xs text-gray-500 p-3 text-center">登録されたリポジトリはありません</p>`;
        return;
    }

    // 各リポジトリを非同期処理で走査
    for (const repo of repos) {
        const sizeStr = await getRepoSizeString(repo.id);
        const isActive = currentRepoId === repo.id;

        // リスト項目を内包するコンテナ要素
        const itemDiv = document.createElement('div');
        itemDiv.className = `flex items-center justify-between p-2 rounded text-sm transition ${isActive ? 'bg-indigo-900-50 border border-indigo-700 text-indigo-200' : 'text-gray-300 hover-bg-gray-700 hover-text-white'}`;
        
        // 左側：リポジトリ基本情報（クリックで選択可能）
        const infoBtn = document.createElement('button');
        infoBtn.className = "flex-1 text-left bg-transparent border-0 p-0 m-0 cursor-pointer overflow-hidden";
        infoBtn.innerHTML = `
            <div class="font-medium truncate">${repo.name}</div>
            <div class="text-10px text-gray-500 truncate">${repo.id}</div>
            <div class="text-10px text-indigo-400 font-mono mt-0-5">LocalSize: ${sizeStr}</div>
        `;
        infoBtn.addEventListener('click', () => selectRepository(repo.id));
        
        // 右側：ローカルデータ削除ボタン
        const deleteBtn = document.createElement('button');
        deleteBtn.className = "text-xs text-gray-500 hover-text-red-400 p-1 rounded transition ml-2 flex-shrink-0 bg-transparent border-0 cursor-pointer";
        deleteBtn.innerHTML = `
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
        `;
        deleteBtn.title = "このリポジトリのローカルデータを完全に削除します";
        
        // 削除確認イベントのバインド
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation(); // 親要素へのクリック伝播（リポジトリ選択）を遮断
            await handleRepoDelete(repo.id, repo.name);
        });
        
        itemDiv.appendChild(infoBtn);
        itemDiv.appendChild(deleteBtn);
        repoListContainer.appendChild(itemDiv);
    }
}

// 誤操作防止の安全なデータ削除ハンドラ
async function handleRepoDelete(repoId, repoName) {
    const warningMessage = 
        `【警告】リポジトリ「${repoName}」のローカルデータを削除しますか？\n\n` +
        `● IndexedDB内のすべてのキャッシュファイルデータが破棄されます。\n` +
        `● GitHub上のリモートリポジトリや登録済み「data.csv」は一切削除されません。\n\n` +
        `本当に削除してよろしいですか？`;
                
    if (confirm(warningMessage)) {
        try {
            // ローカルストレージ（IndexedDB）の関連レコードを一括クレンジング
            await db.repositories.delete(repoId);
            await db.files.where('repoId').equals(repoId).delete();
            await db.csv_meta.delete(repoId);
            
            // 削除されたリポジトリが現在アクティブだった場合、メイン表示エリアを初期化
            if (currentRepoId === repoId) {
                currentRepoId = null;
                currentRepoTitle.innerText = 'リポジトリを選択してください';
                currentRepoIdEl.innerText = '';
                repoPlaceholder.classList.remove('hidden');
                repoContentArea.classList.add('hidden');
                btnExportZip.classList.add('hidden');
            }
            
            alert(`リポジトリ「${repoName}」のローカルキャッシュデータを正常に削除しました。`);
            await refreshRepoList();
        } catch (error) {
            console.error(error);
            alert(`削除の処理中にエラーが発生しました: ${error.message}`);
        }
    }
}

// リポジトリ選択時の処理
async function selectRepository(repoId) {
    currentRepoId = repoId;
    const repo = await db.repositories.get(repoId);
    if (!repo) return;

    currentRepoTitle.innerText = repo.name;
    currentRepoIdEl.innerText = repo.id;
    
    repoPlaceholder.classList.add('hidden');
    repoContentArea.classList.remove('hidden');
    btnExportZip.classList.remove('hidden');

    await refreshRepoList(); 
    await loadFilesTable();
}

// ファイル一覧テーブルのロード
async function loadFilesTable() {
    if (!currentRepoId) return;
    const files = await db.files.where('repoId').equals(currentRepoId).reverse().toArray();
    fileTableBody.innerHTML = '';

    if (files.length === 0) {
        fileTableBody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-gray-500 text-xs">データがありません。上にドロップして追加してください。</td></tr>`;
        return;
    }

    for (const file of files) {
        const csvMeta = await db.csv_meta.get(currentRepoId);
        let note = '';
        if (csvMeta) {
            const lines = csvMeta.csvText.split('\n');
            const targetLine = lines.find(line => line.includes(file.filename));
            if (targetLine) {
                const cols = targetLine.split('","').map(c => c.replace(/^"|"$/g, ''));
                note = cols[3] || '';
            }
        }

        const tr = document.createElement('tr');
        tr.className = "hover-bg-gray-750-50 transition";
        tr.innerHTML = `
            <td class="p-3 font-mono text-xs text-indigo-300 break-all">${file.filename}</td>
            <td class="p-3 font-mono text-xs text-gray-400 max-w-150px truncate" title="${file.sha256}">${file.sha256}</td>
            <td class="p-3 text-gray-200 break-words max-w-200px">${escapeHtml(note)}</td>
            <td class="p-3 text-gray-400 text-xs">${file.createdAt}</td>
        `;
        fileTableBody.appendChild(tr);
    }
}

// ドラッグ＆ドロップ ＆ 記録機能
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('border-indigo-500', 'bg-gray-750'); });
dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('border-indigo-500', 'bg-gray-750'); });
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('border-indigo-500', 'bg-gray-750');
    if (e.dataTransfer.files.length > 0) {
        handleFileSelect(e.dataTransfer.files[0]);
    }
});
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFileSelect(e.target.files[0]);
    }
});

// ファイル処理のコアロジック
async function handleFileSelect(file) {
    if (!currentRepoId) return alert('最初にリポジトリを選択してください。');

    try {
        const renamedFilename = generateJstFilename(file.name);

        const arrayBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const sha256Hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        pendingFile = {
            fileObject: file,
            filename: renamedFilename,
            sha256: sha256Hash,
            blob: new Blob([arrayBuffer], { type: file.type || 'application/octet-stream' })
        };

        modalFilenamePreview.innerText = renamedFilename;
        modalNoteText.value = '';
        noteModal.classList.remove('hidden');

    } catch (error) {
        console.error(error);
        alert(`ファイル解析に失敗しました: ${error.message}`);
    }
}

btnModalCancel.addEventListener('click', () => {
    noteModal.classList.add('hidden');
    pendingFile = null;
});

btnModalSubmit.addEventListener('click', async () => {
    if (!pendingFile || !currentRepoId) return;

    btnModalSubmit.disabled = true;
    btnModalSubmit.innerText = '同期中...';

    try {
        const note = modalNoteText.value.trim().replace(/"/g, '""'); 
        const now = new Date();
        const timestampJst = formatDateJst(now);

        await db.files.add({
            filename: pendingFile.filename,
            repoId: currentRepoId,
            sha256: pendingFile.sha256,
            fileData: pendingFile.blob,
            createdAt: timestampJst
        });

        const csvMeta = await db.csv_meta.get(currentRepoId);
        let currentCsvText = csvMeta ? csvMeta.csvText : "timestamp(jst),filename,sha256,note\n";
        
        const newLine = `"${timestampJst}","${pendingFile.filename}","${pendingFile.sha256}","${note}"\n`;
        currentCsvText += newLine;

        await db.csv_meta.put({ repoId: currentRepoId, csvText: currentCsvText });

        let fileSha = null;
        try {
            const githubFileInfo = await fetchGitHubAPI(`/repos/${currentRepoId}/contents/data.csv`);
            fileSha = githubFileInfo.sha;
        } catch (e) {}

        const base64Content = btoa(unescape(encodeURIComponent(currentCsvText)));
        await fetchGitHubAPI(`/repos/${currentRepoId}/contents/data.csv`, 'PUT', {
            message: `Update data.csv: Add ${pendingFile.filename}`,
            content: base64Content,
            sha: fileSha || undefined
        });

        await db.repositories.update(currentRepoId, { updatedAt: timestampJst });

        noteModal.classList.add('hidden');
        pendingFile = null;
        
        // ファイル追加に伴うデータサイズの増分をサイドバーに即時反映
        await refreshRepoList();
        await loadFilesTable();
        alert('ローカル保存およびGitHubへの同期が完了しました。');

    } catch (error) {
        console.error(error);
        alert(`同期または保存に失敗しました。データはIndexedDBのみ保持されます: ${error.message}`);
    } finally {
        btnModalSubmit.disabled = false;
        btnModalSubmit.innerText = '確定して同期 (Push)';
    }
});

// ローカルエクスポート機能 (JSZip)
btnExportZip.addEventListener('click', async () => {
    if (!currentRepoId) return;
    
    btnExportZip.disabled = true;
    btnExportZip.innerText = 'ZIP生成中...';

    try {
        const zip = new JSZip();
        
        const csvMeta = await db.csv_meta.get(currentRepoId);
        const csvText = csvMeta ? csvMeta.csvText : "timestamp(jst),filename,sha256,note\n";
        zip.file("data.csv", csvText);

        const repo = await db.repositories.get(currentRepoId);
        const metaJson = {
            repoId: currentRepoId,
            repoName: repo ? repo.name : "unknown",
            exportedAt: formatDateJst(new Date())
        };
        zip.file("meta.json", JSON.stringify(metaJson, null, 2));

        const imgFolder = zip.folder("raw_images");
        const files = await db.files.where('repoId').equals(currentRepoId).toArray();

        for (const file of files) {
            imgFolder.file(file.filename, file.fileData);
        }

        const content = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentRepoId.replace('/', '_')}_backup.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

    } catch (error) {
        console.error(error);
        alert(`ZIPのエクスポートに失敗しました: ${error.message}`);
    } finally {
        btnExportZip.disabled = false;
        btnExportZip.innerText = '📥 ローカルバックアップ (ZIP)';
    }
});

// ユーティリティ関数
function generateJstFilename(originalName) {
    const now = new Date();
    const pad = (num) => String(num).padStart(2, '0');
    
    const yy = String(now.getFullYear()).slice(-2);
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const min = pad(now.getMinutes());
    const ss = pad(now.getSeconds());

    const timestamp = `${yy}${mm}${dd}_${hh}${min}${ss}`;
    const cleanName = originalName.replace(/[\s,]/g, '_');
    return `${timestamp}_${cleanName}`;
}

function formatDateJst(date) {
    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeHtml(string) {
    if (!string) return '';
    return string.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}