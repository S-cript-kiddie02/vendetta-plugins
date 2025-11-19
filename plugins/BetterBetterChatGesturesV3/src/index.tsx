import { logger } from "@vendetta";
import Settings from "./components/Settings";

const BetterChatGestures = {
    onLoad() {
        logger.log("BRUTEFORCE: Démarrage de la recherche approfondie...");

        const cache = window.vendetta?.metro?.cache || new Map();
        const foundHandlers = [];

        // On parcourt absolument tout
        for (const [id, module] of cache) {
            if (!module || !module.exports) continue;

            const exports = module.exports;
            
            // On vérifie les exports directs, le default, et les prototypes
            const candidates = [
                { name: "exports", obj: exports },
                { name: "default", obj: exports.default },
                { name: "prototype", obj: exports.prototype },
                { name: "default.prototype", obj: exports.default?.prototype }
            ];

            for (const { name, obj } of candidates) {
                if (!obj) continue;

                try {
                    const keys = Object.keys(obj);
                    
                    // On cherche tout ce qui ressemble à un clic sur un message
                    // Critères : commence par "handle" ou "on", et contient "Tap" ou "Press"
                    const interestingKeys = keys.filter(k => 
                        (k.startsWith("handle") || k.startsWith("on")) && 
                        (k.toLowerCase().includes("tap") || k.toLowerCase().includes("press"))
                    );

                    if (interestingKeys.length > 0) {
                        // Pour filtrer le bruit, on garde ceux qui ont l'air pertinents pour le CHAT
                        // (souvent accompagnés de logic message/channel)
                        const hasChatContext = keys.some(k => 
                            k.toLowerCase().includes("message") || 
                            k.toLowerCase().includes("channel") ||
                            k.toLowerCase().includes("row")
                        );

                        if (hasChatContext) {
                            foundHandlers.push({
                                id,
                                location: name,
                                keys: interestingKeys.join(", ")
                            });
                            
                            logger.log(`CANDIDAT TROUVÉ [ID: ${id}]:`);
                            logger.log(`Keys: ${interestingKeys.join(", ")}`);
                        }
                    }
                } catch (e) {
                    // Ignorer les erreurs d'accès
                }
            }
        }

        if (foundHandlers.length === 0) {
            logger.error("BRUTEFORCE: Rien trouvé... Ils ont tout caché dans le Natif.");
        } else {
            logger.log(`BRUTEFORCE: Finie. ${foundHandlers.length} modules potentiels trouvés.`);
        }
    },

    onUnload() {},
    settings: Settings
};

export default BetterChatGestures;
