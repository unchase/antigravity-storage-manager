const fs = require('fs');
const path = require('path');

const l10nDir = path.join(__dirname, 'l10n');
const files = [
    'bundle.l10n.ar.json', 'bundle.l10n.cs.json', 'bundle.l10n.de.json',
    'bundle.l10n.es.json', 'bundle.l10n.fr.json', 'bundle.l10n.it.json',
    'bundle.l10n.ja.json', 'bundle.l10n.ko.json', 'bundle.l10n.pl.json',
    'bundle.l10n.pt-br.json', 'bundle.l10n.ru.json', 'bundle.l10n.tr.json',
    'bundle.l10n.vi.json', 'bundle.l10n.zh-cn.json', 'bundle.l10n.zh-tw.json'
];

// Translations dictionary
const translations = {
    'ar': {
        "Connected Accounts": "الحسابات المتصلة",
        "Add Account": "إضافة حساب",
        "Switch to {0}": "التبديل إلى {0}",
        "Remove Account": "إزالة الحساب",
        "Active": "نشط",
        "Are you sure you want to remove account {0}?": "هل أنت متأكد أنك تريد إزالة الحساب {0}؟",
        "Switched account successfully": "تم تبديل الحساب بنجاح",
        "Failed to add account: {0}": "فشل إضافة الحساب: {0}",
        "Failed to switch account: {0}": "فشل تبديل الحساب: {0}",
        "Failed to remove account: {0}": "فشل إزالة الحساب: {0}",
        "Account removed": "تمت إزالة الحساب",
        "Google Drive Sync Accounts": "حسابات مزامنة Google Drive",
        "Add Drive Account": "إضافة حساب Drive",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "قم بتوصيل Google Drive لمزامنة محفوظات المحادثة. هذا لا يقوم بتسجيل الدخول إلى محادثة Antigravity.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "يجب عليك منح الإذن \"عرض وحذف وإنشاء وتعديل ملفات Google Drive المحددة التي تستخدمها مع هذا التطبيق فقط\" لاستخدام هذا الامتداد.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "تم رفض الإذن. يرجى إزالة هذا الحساب وإضافته مرة أخرى، مع التأكد من منح إذن الوصول إلى الملف.",
        "Permission denied creating folder. Please re-authenticate.": "تم رفض الإذن بإنشاء مجلد. يرجى إعادة المصادقة."
    },
    'cs': {
        "Connected Accounts": "Připojené účty",
        "Add Account": "Přidat účet",
        "Switch to {0}": "Přepnout na {0}",
        "Remove Account": "Odstranit účet",
        "Active": "Aktivní",
        "Are you sure you want to remove account {0}?": "Opravdu chcete odstranit účet {0}?",
        "Switched account successfully": "Účet byl úspěšně přepnut",
        "Failed to add account: {0}": "Přidání účtu se nezdařilo: {0}",
        "Failed to switch account: {0}": "Přepnutí účtu se nezdařilo: {0}",
        "Failed to remove account: {0}": "Odstranění účtu se nezdařilo: {0}",
        "Account removed": "Účet byl odstraněn",
        "Google Drive Sync Accounts": "Účty synchronizace Google Drive",
        "Add Drive Account": "Přidat účet Drive",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "Připojte Google Drive pro synchronizaci historie konverzací. Toto vás NEPŘIHLÁSÍ do chatu Antigravity.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "Abyste mohli toto rozšíření používat, musíte udělit oprávnění „Zobrazovat, upravovat, vytvářet a mazat pouze konkrétní soubory na Disku Google, které používáte s touto aplikací“.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "Oprávnění odepřeno. Odeberte a znovu přidejte tento účet a ujistěte se, že jste udělili oprávnění k přístupu k souborům.",
        "Permission denied creating folder. Please re-authenticate.": "Oprávnění k vytvoření složky odepřeno. Proveďte prosím novou autentizaci."
    },
    'de': {
        "Connected Accounts": "Verbundene Konten",
        "Add Account": "Konto hinzufügen",
        "Switch to {0}": "Zu {0} wechseln",
        "Remove Account": "Konto entfernen",
        "Active": "Aktiv",
        "Are you sure you want to remove account {0}?": "Möchten Sie das Konto {0} wirklich entfernen?",
        "Switched account successfully": "Konto erfolgreich gewechselt",
        "Failed to add account: {0}": "Konto konnte nicht hinzugefügt werden: {0}",
        "Failed to switch account: {0}": "Konto konnte nicht gewechselt werden: {0}",
        "Failed to remove account: {0}": "Konto konnte nicht entfernt werden: {0}",
        "Account removed": "Konto entfernt",
        "Google Drive Sync Accounts": "Google Drive Synchronisationskonten",
        "Add Drive Account": "Drive-Konto hinzufügen",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "Verbinden Sie Google Drive, um den Gesprächsverlauf zu synchronisieren. Dies meldet Sie NICHT beim Antigravity Chat an.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "Sie müssen die Berechtigung „Nur die spezifischen Google Drive-Dateien ansehen, bearbeiten, erstellen und löschen, die Sie mit dieser App verwenden“ erteilen, um diese Erweiterung nutzen zu können.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "Zugriff verweigert. Bitte entfernen Sie dieses Konto und fügen Sie es erneut hinzu. Stellen Sie sicher, dass Sie die Dateizugriffsberechtigung erteilen.",
        "Permission denied creating folder. Please re-authenticate.": "Berechtigung zum Erstellen des Ordners verweigert. Bitte authentifizieren Sie sich erneut."
    },
    'es': {
        "Connected Accounts": "Cuentas conectadas",
        "Add Account": "Añadir cuenta",
        "Switch to {0}": "Cambiar a {0}",
        "Remove Account": "Eliminar cuenta",
        "Active": "Activo",
        "Are you sure you want to remove account {0}?": "¿Está seguro de que desea eliminar la cuenta {0}?",
        "Switched account successfully": "Cuenta cambiada correctamente",
        "Failed to add account: {0}": "Error al añadir la cuenta: {0}",
        "Failed to switch account: {0}": "Error al cambiar de cuenta: {0}",
        "Failed to remove account: {0}": "Error al eliminar la cuenta: {0}",
        "Account removed": "Cuenta eliminada",
        "Google Drive Sync Accounts": "Cuentas de sincronización de Google Drive",
        "Add Drive Account": "Añadir cuenta de Drive",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "Conecta Google Drive para sincronizar el historial de conversaciones. Esto NO te inicia sesión en Antigravity Chat.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "Debe conceder el permiso \"Ver, editar, crear y eliminar solo los archivos específicos de Google Drive que use con esta aplicación\" para utilizar esta extensión.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "Permiso denegado. Elimine y vuelva a agregar esta cuenta, asegurándose de otorgar el permiso de acceso a archivos.",
        "Permission denied creating folder. Por favor, vuelva a autenticarse.": "Permiso denegado para crear carpeta. Por favor, vuelva a autenticarse."
    },
    'fr': {
        "Connected Accounts": "Comptes connectés",
        "Add Account": "Ajouter un compte",
        "Switch to {0}": "Basculer vers {0}",
        "Remove Account": "Supprimer le compte",
        "Active": "Actif",
        "Are you sure you want to remove account {0}?": "Voulez-vous vraiment supprimer le compte {0} ?",
        "Switched account successfully": "Compte changé avec succès",
        "Failed to add account: {0}": "Échec de l'ajout du compte : {0}",
        "Failed to switch account: {0}": "Échec du changement de compte : {0}",
        "Failed to remove account: {0}": "Échec de la suppression du compte : {0}",
        "Account removed": "Compte supprimé",
        "Google Drive Sync Accounts": "Comptes de synchronisation Google Drive",
        "Add Drive Account": "Ajouter un compte Drive",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "Connectez Google Drive pour synchroniser l'historique des conversations. Cela ne vous connecte PAS au chat Antigravity.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "Vous devez accorder l'autorisation « Voir, modifier, créer et supprimer uniquement les fichiers Google Drive spécifiques que vous utilisez avec cette application » pour utiliser cette extension.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "Permission refusée. Veuillez supprimer et rajouter ce compte, en vous assurant d'accorder l'autorisation d'accès aux fichiers.",
        "Permission denied creating folder. Please re-authenticate.": "Permission refusée de créer le dossier. Veuillez vous authentifier à nouveau."
    },
    'it': {
        "Connected Accounts": "Account collegati",
        "Add Account": "Aggiungi account",
        "Switch to {0}": "Passa a {0}",
        "Remove Account": "Rimuovi account",
        "Active": "Attivo",
        "Are you sure you want to remove account {0}?": "Sei sicuro di voler rimuovere l'account {0}?",
        "Switched account successfully": "Account cambiato con successo",
        "Failed to add account: {0}": "Impossibile aggiungere l'account: {0}",
        "Failed to switch account: {0}": "Impossibile cambiare account: {0}",
        "Failed to remove account: {0}": "Impossibile rimuovere l'account: {0}",
        "Account removed": "Account rimosso",
        "Google Drive Sync Accounts": "Account di sincronizzazione Google Drive",
        "Add Drive Account": "Aggiungi account Drive",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "Collega Google Drive per sincronizzare la cronologia delle conversazioni. Questo NON ti fa accedere alla chat di Antigravity.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "Devi concedere l'autorizzazione \"Vedi, modifica, crea ed elimina solo i file specifici di Google Drive che utilizzi con questa app\" per utilizzare questa estensione.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "Permesso negato. Rimuovi e aggiungi nuovamente questo account, assicurandoti di concedere l'autorizzazione di accesso ai file.",
        "Permission denied creating folder. Please re-authenticate.": "Permesso negato per la creazione della cartella. Effettua nuovamente l'autenticazione."
    },
    'ja': {
        "Connected Accounts": "接続済みアカウント",
        "Add Account": "アカウントを追加",
        "Switch to {0}": "{0} に切り替え",
        "Remove Account": "アカウントを削除",
        "Active": "アクティブ",
        "Are you sure you want to remove account {0}?": "本当にアカウント {0} を削除しますか？",
        "Switched account successfully": "アカウントを切り替えました",
        "Failed to add account: {0}": "アカウントの追加に失敗しました: {0}",
        "Failed to switch account: {0}": "アカウントの切り替えに失敗しました: {0}",
        "Failed to remove account: {0}": "アカウントの削除に失敗しました: {0}",
        "Account removed": "アカウントを削除しました",
        "Google Drive Sync Accounts": "Google Drive同期アカウント",
        "Add Drive Account": "Driveアカウントを追加",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "Google Driveを接続して会話履歴を同期します。これはAntigravity Chatへのサインインではありません。",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "この拡張機能を使用するには、「このアプリで使用する特定の Google ドライブ ファイルのみを表示、編集、作成、削除する」権限を付与する必要があります。",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "アクセスが拒否されました。このアカウントを削除して再度追加し、ファイルアクセス権限を付与してください。",
        "Permission denied creating folder. Please re-authenticate.": "フォルダの作成権限がありません。再認証してください。"
    },
    'ko': {
        "Connected Accounts": "연결된 계정",
        "Add Account": "계정 추가",
        "Switch to {0}": "{0}(으)로 전환",
        "Remove Account": "계정 제거",
        "Active": "활성",
        "Are you sure you want to remove account {0}?": "정말로 {0} 계정을 제거하시겠습니까?",
        "Switched account successfully": "계정이 성공적으로 전환되었습니다",
        "Failed to add account: {0}": "계정 추가 실패: {0}",
        "Failed to switch account: {0}": "계정 전환 실패: {0}",
        "Failed to remove account: {0}": "계정 제거 실패: {0}",
        "Account removed": "계정이 제거되었습니다",
        "Google Drive Sync Accounts": "Google Drive 동기화 계정",
        "Add Drive Account": "Drive 계정 추가",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "대화 기록을 동기화하려면 Google Drive를 연결하세요. 이것은 Antigravity Chat에 로그인하지 않습니다.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "이 확장 프로그램을 사용하려면 \"이 앱에서 사용하는 특정 Google Drive 파일만 보기, 수정, 만들기 및 삭제\" 권한을 부여해야 합니다.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "권한이 거부되었습니다. 이 계정을 제거한 후 다시 추가하고, 파일 액세스 권한을 부여했는지 확인하세요.",
        "Permission denied creating folder. Please re-authenticate.": "폴더 생성 권한이 거부되었습니다. 다시 인증해 주세요."
    },
    'pl': {
        "Connected Accounts": "Połączone konta",
        "Add Account": "Dodaj konto",
        "Switch to {0}": "Przełącz na {0}",
        "Remove Account": "Usuń konto",
        "Active": "Aktywne",
        "Are you sure you want to remove account {0}?": "Czy na pewno chcesz usunąć konto {0}?",
        "Switched account successfully": "Pomyślnie przełączono konto",
        "Failed to add account: {0}": "Nie udało się dodać konta: {0}",
        "Failed to switch account: {0}": "Nie udało się przełączyć konta: {0}",
        "Failed to remove account: {0}": "Nie udało się usunąć konta: {0}",
        "Account removed": "Konto usunięte",
        "Google Drive Sync Accounts": "Konta synchronizacji Google Drive",
        "Add Drive Account": "Dodaj konto Drive",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "Połącz Google Drive, aby zsynchronizować historię rozmów. To NIE loguje Cię do czatu Antigravity.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "Aby korzystać z tego rozszerzenia, musisz on udzielić uprawnienia „Wyświetlanie, edytowanie, tworzenie i usuwanie tylko tych plików na Dysku Google, których używasz w tej aplikacji”.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "Odmowa dostępu. Usuń i dodaj ponownie to konto, upewniając się, że udzieliłeś uprawnienia dostępu do plików.",
        "Permission denied creating folder. Please re-authenticate.": "Odmowa uprawnień do utworzenia folderu. Proszę uwierzytelnić się ponownie."
    },
    'pt-br': {
        "Connected Accounts": "Contas Conectadas",
        "Add Account": "Adicionar Conta",
        "Switch to {0}": "Mudar para {0}",
        "Remove Account": "Remover Conta",
        "Active": "Ativo",
        "Are you sure you want to remove account {0}?": "Tem certeza de que deseja remover a conta {0}?",
        "Switched account successfully": "Conta alterada com sucesso",
        "Failed to add account: {0}": "Falha ao adicionar conta: {0}",
        "Failed to switch account: {0}": "Falha ao mudar de conta: {0}",
        "Failed to remove account: {0}": "Falha ao remover conta: {0}",
        "Account removed": "Conta removida",
        "Google Drive Sync Accounts": "Contas de Sincronização do Google Drive",
        "Add Drive Account": "Adicionar Conta Drive",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "Conecte o Google Drive para sincronizar o histórico de conversas. Isso NÃO faz login no Antigravity Chat.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "Você deve conceder a permissão \"Ver, editar, criar e excluir apenas os arquivos específicos do Google Drive que você usa com este aplicativo\" para usar esta extensão.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "Permissão negada. Remova e adicione novamente esta conta, garantindo que você conceda a permissão de acesso aos arquivos.",
        "Permission denied creating folder. Please re-authenticate.": "Permissão negada para criar pasta. Por favor, autentique-se novamente."
    },
    'ru': {
        "Connected Accounts": "Подключенные аккаунты",
        "Add Account": "Добавить аккаунт",
        "Switch to {0}": "Переключиться на {0}",
        "Remove Account": "Удалить аккаунт",
        "Active": "Активен",
        "Are you sure you want to remove account {0}?": "Вы уверены, что хотите удалить аккаунт {0}?",
        "Switched account successfully": "Аккаунт успешно переключен",
        "Failed to add account: {0}": "Не удалось добавить аккаунт: {0}",
        "Failed to switch account: {0}": "Не удалось переключить аккаунт: {0}",
        "Failed to remove account: {0}": "Не удалось удалить аккаунт: {0}",
        "Account removed": "Аккаунт удален",
        "Google Drive Sync Accounts": "Аккаунты синхронизации Google Drive",
        "Add Drive Account": "Добавить аккаунт Drive",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "Подключите Google Drive для синхронизации истории чатов. Это НЕ выполняет вход в Antigravity Chat.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "Вы должны предоставить разрешение «Просматривать, переименовывать, создавать и удалять только те файлы на Google Диске, которые вы используете с этим приложением» для работы расширения.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "Доступ запрещен. Пожалуйста, удалите и снова добавьте этот аккаунт, убедившись, что вы предоставили разрешение на доступ к файлам.",
        "Permission denied creating folder. Please re-authenticate.": "Нет прав на создание папки. Пожалуйста, пройдите повторную аутентификацию."
    },
    'tr': {
        "Connected Accounts": "Bağlı Hesaplar",
        "Add Account": "Hesap Ekle",
        "Switch to {0}": "{0} hesabına geç",
        "Remove Account": "Hesabı Kaldır",
        "Active": "Aktif",
        "Are you sure you want to remove account {0}?": "{0} hesabını kaldırmak istediğinizden emin misiniz?",
        "Switched account successfully": "Hesap başarıyla değiştirildi",
        "Failed to add account: {0}": "Hesap eklenemedi: {0}",
        "Failed to switch account: {0}": "Hesap değiştirilemedi: {0}",
        "Failed to remove account: {0}": "Hesap kaldırılamadı: {0}",
        "Account removed": "Hesap kaldırıldı",
        "Google Drive Sync Accounts": "Google Drive Eşitleme Hesapları",
        "Add Drive Account": "Drive Hesabı Ekle",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "Konuşma geçmişini eşitlemek için Google Drive'ı bağlayın. Bu işlem Antigravity Chat'e giriş yapmanızı SAĞLAMAZ.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "Bu uzantıyı kullanmak için \"Yalnızca bu uygulamayla kullandığınız belirli Google Drive dosyalarını görme, düzenleme, oluşturma ve silme\" iznini vermelisiniz.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "İzin reddedildi. Lütfen bu hesabı kaldırıp yeniden ekleyin ve dosya erişim izni verdiğinizden emin olun.",
        "Permission denied creating folder. Please re-authenticate.": "Klasör oluşturma izni reddedildi. Lütfen tekrar kimlik doğrulaması yapın."
    },
    'vi': {
        "Connected Accounts": "Tài khoản đã kết nối",
        "Add Account": "Thêm tài khoản",
        "Switch to {0}": "Chuyển sang {0}",
        "Remove Account": "Xóa tài khoản",
        "Active": "Đang hoạt động",
        "Are you sure you want to remove account {0}?": "Bạn có chắc chắn muốn xóa tài khoản {0} không?",
        "Switched account successfully": "Đã chuyển tài khoản thành công",
        "Failed to add account: {0}": "Thêm tài khoản thất bại: {0}",
        "Failed to switch account: {0}": "Chuyển tài khoản thất bại: {0}",
        "Failed to remove account: {0}": "Xóa tài khoản thất bại: {0}",
        "Account removed": "Đã xóa tài khoản",
        "Google Drive Sync Accounts": "Tài khoản đồng bộ hóa Google Drive",
        "Add Drive Account": "Thêm tài khoản Drive",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "Kết nối Google Drive để đồng bộ lịch sử hội thoại. Điều này KHÔNG đăng nhập bạn vào Antigravity Chat.",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "Bạn phải cấp quyền \"Xem, chỉnh sửa, tạo và xóa chỉ những tệp Google Drive cụ thể mà bạn sử dụng với ứng dụng này\" để sử dụng tiện ích mở rộng này.",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "Quyền bị từ chối. Vui lòng xóa và thêm lại tài khoản này, đảm bảo bạn cấp quyền truy cập tệp.",
        "Permission denied creating folder. Please re-authenticate.": "Quyền tạo thư mục bị từ chối. Vui lòng xác thực lại."
    },
    'zh-cn': {
        "Connected Accounts": "已连接账户",
        "Add Account": "添加账户",
        "Switch to {0}": "切换到 {0}",
        "Remove Account": "移除账户",
        "Active": "当前活跃",
        "Are you sure you want to remove account {0}?": "您确定要移除账户 {0} 吗？",
        "Switched account successfully": "账户切换成功",
        "Failed to add account: {0}": "添加账户失败：{0}",
        "Failed to switch account: {0}": "切换账户失败：{0}",
        "Failed to remove account: {0}": "移除账户失败：{0}",
        "Account removed": "账户已移除",
        "Google Drive Sync Accounts": "Google Drive 同步账户",
        "Add Drive Account": "添加 Drive 账户",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "连接 Google Drive 以同步对话历史记录。这不会登录 Antigravity Chat。",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "您必须授予“查看、编辑、创建和删除您用于此应用的特定 Google 云端硬盘文件”权限才能使用此扩展程序。",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "权限被拒绝。请移除并重新添加此帐户，确保您授予了文件访问权限。",
        "Permission denied creating folder. Please re-authenticate.": "创建文件夹权限被拒绝。请重新进行身份验证。"
    },
    'zh-tw': {
        "Connected Accounts": "已連結帳戶",
        "Add Account": "新增帳戶",
        "Switch to {0}": "切換至 {0}",
        "Remove Account": "移除帳戶",
        "Active": "目前使用",
        "Are you sure you want to remove account {0}?": "您確定要移除帳戶 {0} 嗎？",
        "Switched account successfully": "帳戶切換成功",
        "Failed to add account: {0}": "新增帳戶失敗：{0}",
        "Failed to switch account: {0}": "切換帳戶失敗：{0}",
        "Failed to remove account: {0}": "移除帳戶失敗：{0}",
        "Account removed": "帳戶已移除",
        "Google Drive Sync Accounts": "Google Drive 同步帳戶",
        "Add Drive Account": "新增 Drive 帳戶",
        "Connect Google Drive to sync conversation history. This does NOT sign you into Antigravity Chat.": "連接 Google Drive 以同步對話記錄。這不會登入 Antigravity Chat。",
        "You must grant the \"See, edit, create, and delete only the specific Google Drive files you use with this app\" permission to use this extension.": "您必須授權「查看、編輯、建立及刪除您搭配這個應用程式使用的特定 Google 雲端硬碟檔案」，才能使用此擴充功能。",
        "Permission denied. Please remove and re-add this account, ensuring you grant the file access permission.": "權限被拒絕。請移除並重新新增此帳戶，並確認您已授權存取檔案。",
        "Permission denied creating folder. Please re-authenticate.": "建立資料夾權限被拒絕。請重新驗證。"
    }
};

files.forEach(file => {
    const filePath = path.join(l10nDir, file);

    // Extract lang code from filename: bundle.l10n.XX.json
    const match = file.match(/bundle\.l10n\.([a-z0-9-]+)\.json/i);
    if (!match) return;
    const lang = match[1];

    if (!fs.existsSync(filePath)) {
        console.warn(`File not found: ${file}`);
        return;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const json = JSON.parse(content);
        const newStrings = translations[lang];

        if (!newStrings) {
            console.warn(`No translations for ${lang}`);
            return;
        }

        let updated = false;
        for (const [key, value] of Object.entries(newStrings)) {
            if (!json[key] || json[key] !== value) { // Check if value is different too (for updates)
                json[key] = value;
                updated = true;
            }
        }

        if (updated) {
            fs.writeFileSync(filePath, JSON.stringify(json, null, 4), 'utf8');
            console.log(`Updated ${file}`);
        } else {
            console.log(`No updates needed for ${file}`);
        }

    } catch (e) {
        console.error(`Error processing ${file}:`, e);
    }
});
