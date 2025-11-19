import { findByProps } from "@vendetta/metro";
import { logger } from "@vendetta";
import Settings from "./components/Settings";

// Recherche du module MessagesHandlers
let MessagesHandlersModule = findByProps("MessagesHandlers");
if (!MessagesHandlersModule) {
    const allModules = window.vendetta?.metro?.cache || new Map();
    for (const [key, module] of allModules) {
        if (module?.exports?.MessagesHandlers) {
            MessagesHandlersModule = module.exports;
            break;
        }
    }
}
const MessagesHandlers = MessagesHandlersModule?.MessagesHandlers;

const BetterChatGestures = {
    scannerRun: false, // Pour éviter de spammer les logs 50 fois

    onLoad() {
        logger.log("SCANNER: Démarrage...");

        if (!MessagesHandlers) {
            logger.error("SCANNER: MessagesHandlers introuvable.");
            return;
        }

        const proto = MessagesHandlers.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "params");

        if (descriptor && descriptor.get) {
            logger.log("SCANNER: Getter 'params' trouvé. Injection du mouchard...");
            
            const originalGetter = descriptor.get;
            
            Object.defineProperty(proto, "params", {
                configurable: true,
                get() {
                    const result = originalGetter.call(this);
                    
                    // On scanne l'objet seulement la première fois qu'on le voit
                    if (result && !BetterChatGestures.scannerRun) {
                        BetterChatGestures.scannerRun = true;
                        
                        try {
                            // 1. Les clés directes (propriétés)
                            const keys = Object.keys(result);
                            logger.log("SCANNER [Direct Keys]: " + (keys.length ? keys.join(", ") : "Aucune"));

                            // 2. Les clés du prototype (fonctions héritées/classe)
                            const proto = Object.getPrototypeOf(result);
                            if (proto) {
                                const protoKeys = Object.getOwnPropertyNames(proto);
                                // On filtre les trucs inutiles de base JS
                                const filteredProtoKeys = protoKeys.filter(k => 
                                    k !== "constructor" && k !== "toString" && k !== "toLocaleString"
                                );
                                logger.log("SCANNER [Proto Keys]: " + (filteredProtoKeys.length ? filteredProtoKeys.join(", ") : "Aucune"));
                            }
                            
                            // 3. Dump complet pour être sûr (objet converti en string)
                            logger.log("SCANNER [Structure]: " + JSON.stringify(result, (key, value) => {
                                if (typeof value === 'function') return '[Function]';
                                if (key === 'message' || key === 'channel') return '[Object]'; // Évite les références circulaires énormes
                                return value;
                            }));

                        } catch (e) {
                            logger.error("SCANNER: Erreur pendant l'analyse", e);
                        }
                    }
                    return result;
                }
            });
            
            // Nettoyage auto
            this.unpatch = () => {
                 Object.defineProperty(proto, "params", {
                    configurable: true,
                    get: originalGetter
                });
            };

        } else {
            logger.error("SCANNER: Impossible de trouver le getter 'params' sur le prototype.");
        }
    },

    onUnload() {
        if (this.unpatch) this.unpatch();
    },

    settings: Settings
};

export default BetterChatGestures;
