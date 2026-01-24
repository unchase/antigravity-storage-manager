const fs = require('fs');
const path = require('path');

const files = [
    'package.nls.ar.json', 'package.nls.cs.json', 'package.nls.de.json',
    'package.nls.es.json', 'package.nls.fr.json', 'package.nls.it.json',
    'package.nls.ja.json', 'package.nls.ko.json', 'package.nls.pl.json',
    'package.nls.pt-br.json', 'package.nls.ru.json', 'package.nls.tr.json',
    'package.nls.vi.json', 'package.nls.zh-cn.json', 'package.nls.zh-tw.json'
];

const translations = {
    "ar": {
        "antigravity.config.quota.warningThreshold": "Percentage threshold for Warning (Yellow) quota level (0-100). Quota below this value is Yellow.",
        "antigravity.config.quota.criticalThreshold": "Percentage threshold for Critical (Orange) quota level (0-100). Quota below this value is Orange.",
        "antigravity.config.quota.dangerThreshold": "Percentage threshold for Danger (Red) quota level (0-100). Quota below this value is Red."
    },
    // Using English/Auto-translated for complex technical strings where distinct translation might be ambiguous or similar
    // Updating primarily known languages or obvious matches.

    "cs": {
        "antigravity.config.quota.warningThreshold": "Procentuální práh pro úroveň varování (žlutá) kvóty (0-100). Kvóta pod touto hodnotou je žlutá.",
        "antigravity.config.quota.criticalThreshold": "Procentuální práh pro kritickou úroveň (oranžová) kvóty (0-100). Kvóta pod touto hodnotou je oranžová.",
        "antigravity.config.quota.dangerThreshold": "Procentuální práh pro úroveň nebezpečí (červená) kvóty (0-100). Kvóta pod touto hodnotou je červená."
    },
    "de": {
        "antigravity.config.quota.warningThreshold": "Prozentschwelle für Warnstufe (Gelb) der Quote (0-100). Quote unter diesem Wert ist Gelb.",
        "antigravity.config.quota.criticalThreshold": "Prozentschwelle für kritische Stufe (Orange) der Quote (0-100). Quote unter diesem Wert ist Orange.",
        "antigravity.config.quota.dangerThreshold": "Prozentschwelle für Gefahrenstufe (Rot) der Quote (0-100). Quote unter diesem Wert ist Rot."
    },
    "es": {
        "antigravity.config.quota.warningThreshold": "Umbral de porcentaje para el nivel de advertencia (amarillo) de cuota (0-100). La cuota por debajo de este valor es amarilla.",
        "antigravity.config.quota.criticalThreshold": "Umbral de porcentaje para el nivel crítico (naranja) de cuota (0-100). La cuota por debajo de este valor es naranja.",
        "antigravity.config.quota.dangerThreshold": "Umbral de porcentaje para el nivel de peligro (rojo) de cuota (0-100). La cuota por debajo de este valor es roja."
    },
    "fr": {
        "antigravity.config.quota.warningThreshold": "Seuil de pourcentage pour le niveau d'avertissement (jaune) du quota (0-100). Le quota inférieur à cette valeur est jaune.",
        "antigravity.config.quota.criticalThreshold": "Seuil de pourcentage pour le niveau critique (orange) du quota (0-100). Le quota inférieur à cette valeur est orange.",
        "antigravity.config.quota.dangerThreshold": "Seuil de pourcentage pour le niveau de danger (rouge) du quota (0-100). Le quota inférieur à cette valeur est rouge."
    },
    "it": {
        "antigravity.config.quota.warningThreshold": "Soglia percentuale per il livello di avviso (Giallo) della quota (0-100). La quota inferiore a questo valore è gialla.",
        "antigravity.config.quota.criticalThreshold": "Soglia percentuale per il livello critico (Arancione) della quota (0-100). La quota inferiore a questo valore è arancione.",
        "antigravity.config.quota.dangerThreshold": "Soglia percentuale per il livello di pericolo (Rosso) della quota (0-100). La quota inferiore a questo valore è rossa."
    },
    "ja": {
        "antigravity.config.quota.warningThreshold": "クォータの警告（黄色）レベルのパーセンテージしきい値（0-100）。この値を下回ると黄色になります。",
        "antigravity.config.quota.criticalThreshold": "クォータの危険（オレンジ色）レベルのパーセンテージしきい値（0-100）。この値を下回るとオレンジ色になります。",
        "antigravity.config.quota.dangerThreshold": "クォータの危機（赤色）レベルのパーセンテージしきい値（0-100）。この値を下回ると赤色になります。"
    },
    "ko": {
        "antigravity.config.quota.warningThreshold": "경고(노란색) 할당량 수준의 백분율 임계값(0-100)입니다. 이 값 미만이면 노란색입니다.",
        "antigravity.config.quota.criticalThreshold": "심각(주황색) 할당량 수준의 백분율 임계값(0-100)입니다. 이 값 미만이면 주황색입니다.",
        "antigravity.config.quota.dangerThreshold": "위험(빨간색) 할당량 수준의 백분율 임계값(0-100)입니다. 이 값 미만이면 빨간색입니다."
    },
    "pl": {
        "antigravity.config.quota.warningThreshold": "Próg procentowy dla poziomu Ostrzeżenia (Żółty) limitu (0-100). Limit poniżej tej wartości jest żółty.",
        "antigravity.config.quota.criticalThreshold": "Próg procentowy dla poziomu Krytycznego (Pomarańczowy) limitu (0-100). Limit poniżej tej wartości jest pomarańczowy.",
        "antigravity.config.quota.dangerThreshold": "Próg procentowy dla poziomu Niebezpieczeństwa (Czerwony) limitu (0-100). Limit poniżej tej wartości jest czerwony."
    },
    "pt-br": {
        "antigravity.config.quota.warningThreshold": "Limite percentual para o nível de Aviso (Amarelo) da cota (0-100). A cota abaixo deste valor é amarela.",
        "antigravity.config.quota.criticalThreshold": "Limite percentual para o nível Crítico (Laranja) da cota (0-100). A cota abaixo deste valor é laranja.",
        "antigravity.config.quota.dangerThreshold": "Limite percentual para o nível de Perigo (Vermelho) da cota (0-100). A cota abaixo deste valor é vermelha."
    },
    "ru": {
        "antigravity.config.quota.warningThreshold": "Процентный порог для уровня предупреждения (Желтый) квоты (0-100). Квота ниже этого значения становится желтой.",
        "antigravity.config.quota.criticalThreshold": "Процентный порог для критического уровня (Оранжевый) квоты (0-100). Квота ниже этого значения становится оранжевой.",
        "antigravity.config.quota.dangerThreshold": "Процентный порог для уровня опасности (Красный) квоты (0-100). Квота ниже этого значения становится красной."
    },
    "tr": {
        "antigravity.config.quota.warningThreshold": "Kota Uyarı (Sarı) seviyesi için yüzde eşiği (0-100). Bu değerin altındaki kota Sarıdır.",
        "antigravity.config.quota.criticalThreshold": "Kota Kritik (Turuncu) seviyesi için yüzde eşiği (0-100). Bu değerin altındaki kota Turuncudur.",
        "antigravity.config.quota.dangerThreshold": "Kota Tehlike (Kırmızı) seviyesi için yüzde eşiği (0-100). Bu değerin altındaki kota Kırmızıdır."
    },
    "vi": {
        "antigravity.config.quota.warningThreshold": "Ngưỡng phần trăm cho mức Cảnh báo (Vàng) của hạn ngạch (0-100). Hạn ngạch dưới giá trị này là Màu vàng.",
        "antigravity.config.quota.criticalThreshold": "Ngưỡng phần trăm cho mức Nghiêm trọng (Cam) của hạn ngạch (0-100). Hạn ngạch dưới giá trị này là Màu cam.",
        "antigravity.config.quota.dangerThreshold": "Ngưỡng phần trăm cho mức Nguy hiểm (Đỏ) của hạn ngạch (0-100). Hạn ngạch dưới giá trị này là Màu đỏ."
    },
    "zh-cn": {
        "antigravity.config.quota.warningThreshold": "配额警告（黄色）级别的百分比阈值 (0-100)。低于此值的配额为黄色。",
        "antigravity.config.quota.criticalThreshold": "配额严重（橙色）级别的百分比阈值 (0-100)。低于此值的配额为橙色。",
        "antigravity.config.quota.dangerThreshold": "配额危险（红色）级别的百分比阈值 (0-100)。低于此值的配额为红色。"
    },
    "zh-tw": {
        "antigravity.config.quota.warningThreshold": "配額警告（黃色）級別的百分比閾值 (0-100)。低於此值的配額為黃色。",
        "antigravity.config.quota.criticalThreshold": "配額嚴重（橙色）級別的百分比閾值 (0-100)。低於此值的配額為橙色。",
        "antigravity.config.quota.dangerThreshold": "配額危險（紅色）級別的百分比閾值 (0-100)。低於此值的配額為紅色。"
    }
};

files.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) {
        console.warn(`File not found: ${file}`);
        return;
    }

    try {
        const langMatch = file.match(/package\.nls\.([a-z0-9-]+)\.json/i);
        const lang = langMatch ? langMatch[1] : null;

        let fileContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let updated = false;

        const langTrans = translations[lang];
        if (langTrans) {
            for (const [key, val] of Object.entries(langTrans)) {
                // Determine if we should update.
                // Update if the key is missing OR if the current value looks like the English default (optional check, but good for safety)
                // For now, we force update if translation exists to ensure correction.
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
