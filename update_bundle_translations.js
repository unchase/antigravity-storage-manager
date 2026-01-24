const fs = require('fs');
const path = require('path');

const files = [
    'bundle.l10n.ar.json', 'bundle.l10n.cs.json', 'bundle.l10n.de.json',
    'bundle.l10n.es.json', 'bundle.l10n.fr.json', 'bundle.l10n.it.json',
    'bundle.l10n.ja.json', 'bundle.l10n.ko.json', 'bundle.l10n.pl.json',
    'bundle.l10n.pt-br.json', 'bundle.l10n.tr.json', 'bundle.l10n.vi.json',
    'bundle.l10n.zh-cn.json', 'bundle.l10n.zh-tw.json'
];

const translations = {
    "ar": {
        "Permission denied creating folder. Please re-authenticate.": "تم رفض الإذن بإنشاء المجلد. يرجى إعادة المصادقة.",
        "Failed to get/decrypt manifest: {0}": "فشل الحصول على/فك تشفير البيان: {0}",
        "Decryption failed: incorrect password or corrupted data": "فشل فك التشفير: كلمة مرور غير صحيحة أو بيانات تالفة"
    },
    "cs": {
        "Permission denied creating folder. Please re-authenticate.": "Odepřeno oprávnění k vytvoření složky. Prosím, znovu se ověřte.",
        "Failed to get/decrypt manifest: {0}": "Nepodařilo se získat/dešifrovat manifest: {0}",
        "Decryption failed: incorrect password or corrupted data": "Dešifrování selhalo: nesprávné heslo nebo poškozená data"
    },
    "de": {
        "Permission denied creating folder. Please re-authenticate.": "Zugriff verweigert beim Erstellen des Ordners. Bitte erneut authentifizieren.",
        "Failed to get/decrypt manifest: {0}": "Manifest konnte nicht abgerufen/entschlüsselt werden: {0}",
        "Decryption failed: incorrect password or corrupted data": "Entschlüsselung fehlgeschlagen: falsches Passwort oder beschädigte Daten"
    },
    "es": {
        "Permission denied creating folder. Please re-authenticate.": "Permiso denegado al crear la carpeta. Por favor, vuelva a autenticarse.",
        "Failed to get/decrypt manifest: {0}": "Error al obtener/descifrar el manifiesto: {0}",
        "Decryption failed: incorrect password or corrupted data": "Descifrado fallido: contraseña incorrecta o datos corruptos"
    },
    "fr": {
        "Permission denied creating folder. Please re-authenticate.": "Permission refusée lors de la création du dossier. Veuillez vous réauthentifier.",
        "Failed to get/decrypt manifest: {0}": "Échec de la récupération/déchiffrement du manifeste : {0}",
        "Decryption failed: incorrect password or corrupted data": "Déchiffrement échoué : mot de passe incorrect ou données corrompues"
    },
    "it": {
        "Permission denied creating folder. Please re-authenticate.": "Permesso negato durante la creazione della cartella. Per favore riautenticati.",
        "Failed to get/decrypt manifest: {0}": "Impossibile ottenere/decifrare il manifesto: {0}",
        "Decryption failed: incorrect password or corrupted data": "Decifrazione fallita: password errata o dati corrotti"
    },
    "ja": {
        "Permission denied creating folder. Please re-authenticate.": "フォルダの作成権限が拒否されました。再認証してください。",
        "Failed to get/decrypt manifest: {0}": "マニフェストの取得/復号化に失敗しました: {0}",
        "Decryption failed: incorrect password or corrupted data": "復号化に失敗しました: パスワードが間違っているか、データが破損しています"
    },
    "ko": {
        "Permission denied creating folder. Please re-authenticate.": "폴더 생성 권한이 거부되었습니다. 다시 인증해 주세요.",
        "Failed to get/decrypt manifest: {0}": "매니페스트를 가져오거나 복호화하지 못했습니다: {0}",
        "Decryption failed: incorrect password or corrupted data": "복호화 실패: 잘못된 비밀번호이거나 데이터가 손상되었습니다"
    },
    "pl": {
        "Permission denied creating folder. Please re-authenticate.": "Odmowa uprawnień do utworzenia folderu. Proszę uwierzytelnić się ponownie.",
        "Failed to get/decrypt manifest: {0}": "Nie udało się pobrać/odszyfrować manifestu: {0}",
        "Decryption failed: incorrect password or corrupted data": "Odszyfrowywanie nie powiodło się: nieprawidłowe hasło lub uszkodzone dane"
    },
    "pt-br": {
        "Permission denied creating folder. Please re-authenticate.": "Permissão negada ao criar pasta. Por favor, reautentique-se.",
        "Failed to get/decrypt manifest: {0}": "Falha ao obter/descriptografar o manifesto: {0}",
        "Decryption failed: incorrect password or corrupted data": "Falha na descriptografia: senha incorreta ou dados corrompidos"
    },
    "tr": {
        "Permission denied creating folder. Please re-authenticate.": "Klasör oluşturma izni reddedildi. Lütfen tekrar kimlik doğrulayın.",
        "Failed to get/decrypt manifest: {0}": "Bildirim (manifest) alınamadı/şifresi çözülemedi: {0}",
        "Decryption failed: incorrect password or corrupted data": "Şifre çözme başarısız: yanlış parola veya bozuk veri"
    },
    "vi": {
        "Permission denied creating folder. Please re-authenticate.": "Quyền tạo thư mục bị từ chối. Vui lòng xác thực lại.",
        "Failed to get/decrypt manifest: {0}": "Không thể lấy/giải mã bảng kê (manifest): {0}",
        "Decryption failed: incorrect password or corrupted data": "Giải mã thất bại: mật khẩu không đúng hoặc dữ liệu bị hỏng"
    },
    "zh-cn": {
        "Permission denied creating folder. Please re-authenticate.": "创建文件夹权限被拒绝。请重新验证。",
        "Failed to get/decrypt manifest: {0}": "获取/解密清单失败：{0}",
        "Decryption failed: incorrect password or corrupted data": "解密失败：密码错误或数据损坏"
    },
    "zh-tw": {
        "Permission denied creating folder. Please re-authenticate.": "建立資料夾權限被拒絕。請重新驗證。",
        "Failed to get/decrypt manifest: {0}": "取得/解密資訊清單失敗：{0}",
        "Decryption failed: incorrect password or corrupted data": "解密失敗：密碼錯誤或資料損毀"
    }
};

const l10nDir = path.join(__dirname, 'l10n');

files.forEach(file => {
    const filePath = path.join(l10nDir, file);
    if (!fs.existsSync(filePath)) {
        console.warn(`File not found: ${file}`);
        return;
    }

    try {
        const langMatch = file.match(/bundle\.l10n\.([a-z0-9-]+)\.json/i);
        const lang = langMatch ? langMatch[1] : null;

        let fileContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let updated = false;

        const langTrans = translations[lang];
        if (langTrans) {
            for (const [key, val] of Object.entries(langTrans)) {
                // Determine if we should update.
                // Since check_l10n_bundles.js likely added English defaults, we should overwrite if the value matches the key (or close to it)
                // Or simply force overwrite with our "better" translation.

                // Only write if different to minimize noise, but here we expect it to be different (English vs Lang)
                if (fileContent[key] !== val) {
                    fileContent[key] = val;
                    updated = true;
                }
            }
        }

        if (updated) {
            fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 4), 'utf8');
            console.log(`Updated ${file}`);
        } else {
            console.log(`No updates needed for ${file}`);
        }

    } catch (e) {
        console.error(`Error processing ${file}:`, e);
    }
});
