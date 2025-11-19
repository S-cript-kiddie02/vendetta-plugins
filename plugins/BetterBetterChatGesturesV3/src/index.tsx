import { logger } from "@vendetta";
import Settings from "./components/Settings";

const BetterChatGestures = {
    onLoad() {
        logger.log("SEARCHER: Démarrage de la recherche globale...");

        const cache = window.vendetta?.metro?.cache || new Map();
        let foundCount = 0;

        // On parcourt TOUS les modules de l'application
        for (const [id, module] of cache) {
            if (!module || !module.exports) continue;

            const exports = module.exports;
            
            // On vérifie l'export direct, le default, et les prototypes
            const candidates = [
                { name: "exports", obj: exports },
                { name: "default", obj: exports.default },
                { name: "prototype", obj: exports.prototype },
                { name: "default.prototype", obj: exports.default?.prototype }
            ];

            for (const { name, obj } of candidates) {
                if (!obj) continue;

                // On cherche des noms de fonctions clés
                // On cherche large pour être sûr de trouver
                const keys = Object.keys(obj);
                const hasTapMessage = keys.some(k => k === "handleTapMessage" || k === "onTapMessage" || k === "onMessageTap");
                const hasLongPress = keys.some(k => k === "handleLongPressMessage");
                
                if (hasTapMessage || hasLongPress) {
                    foundCount++;
                    logger.log(`SEARCHER [FOUND] Module ID: ${id} | Location: ${name}`);
                    logger.log(`SEARCHERKeys: ${keys.filter(k => k.toLowerCase().includes("message")).join(", ")}`);
                    
                    // Si on trouve, on essaie de voir si c'est le bon
                    if (obj.handleTapMessage) {
                         logger.log("SEARCHER: BINGO! handleTapMessage existe ici!");
                    }
                }
            }
        }

        if (foundCount === 0) {
            logger.error("SEARCHER: Aucun module trouvé avec handleTapMessage ! La fonction a été renommée.");
        } else {
            logger.log(`SEARCHER: Recherche terminée. ${foundCount} candidats trouvés.`);
        }
    },

    onUnload() {},
    settings: Settings
};

export default BetterChatGestures;
