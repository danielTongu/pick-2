/** Canonical immutable vocabulary, limits, card definitions, and timing shared across Pick 2. */
export class Constants {
    /** @type {number} Hosted actor idle limit in milliseconds. */
    static MAX_IDLE_MS = 30 * 1000;

    /** @type {number} Transition countdown length. */
    static COUNTDOWN_SECONDS = 5;

    /** @type {number} Hosted connection attempt timeout. */
    static NETWORK_CONNECTION_TIMEOUT_MS = 3 * 1000;

    /** @type {number} Default maximum actors per room. */
    static ROOM_PLAYER_LIMIT = 4;

    /** @type {number} Default number of cards dealt to each actor. */
    static INITIAL_ITEM_COUNT = 7;

    /** @type {number} Minimum automated-turn delay. */
    static AUTOMATED_ACTOR_DELAY_MIN_MS = 2000;

    /** @type {number} Maximum automated-turn delay. */
    static AUTOMATED_ACTOR_DELAY_MAX_MS = 4000;

    /** @type {Readonly<Record<string, string>>} Connection and notification statuses. */
    static STATUS = Object.freeze({
        CONNECTING: "connecting",
        CONNECTED: "connected",
        DISCONNECTED: "disconnected",
        INFO: "info",
        WARNING: "warning",
        ERROR: "error"
    });

    /** @type {Readonly<Record<string, string>>} Room lifecycle states. */
    static ROOM_STATE = Object.freeze({ WAITING: "waiting", ACTIVE: "active", FINISHED: "finished" });

    /** @type {Readonly<Record<string, string>>} Actor round states. */
    static ACTOR_STATE = Object.freeze({ READY: "ready", ACTIVE: "active", WON: "won", LOST: "lost" });

    /** @type {Readonly<Record<string, string>>} Application views. */
    static VIEWS = Object.freeze({ HOME: "home", ROOM: "room" });

    /** @type {Readonly<Record<string, string>>} Top-level response fields. */
    static RESPONSE_KEYS = Object.freeze({ VIEW: "view", MESSAGE: "message", DATA: "data" });

    /** Canonical notification headings and messages shown by the game and room interfaces. */
    static NOTIFICATIONS = Object.freeze({
        VIEWER_WELCOME: Object.freeze({
            title: "Welcome to Pick 2!",
            message: "You’re viewing the room.\nSelect JOIN to take an open seat and enter the game."
        }),
        PLAYER_WELCOME: Object.freeze({
            title: "Welcome",
            message: "You have a seat in the room.\nOpen HOW TO PLAY below for controls and rules.\n\nGood luck!"
        }),
        MOVED_TO_VIEWING: Object.freeze({ title: "Moved to viewing", message: "You were idle." }),
        ROOM_CLOSED: Object.freeze({ title: "Room closed", message: "No players remain." }),
        INVITE_COPIED: Object.freeze({
            title: "Invite copied",
            message: "Paste the room link wherever you want to share it."
        }),
        COPY_FAILED: Object.freeze({
            title: "Copy failed",
            message: "Copy the address from your browser instead."
        }),
        ROOM_NOT_FOUND: Object.freeze({ title: "Room not found", message: "Check the room name and try again." }),
        ROOM_ALREADY_EXISTS: Object.freeze({
            title: "Room already exists",
            message: "Choose another name or join the existing room."
        }),
        CARDS_DRAWN_TITLE: "Cards drawn",
        INVALID_NAME_TITLE: "Invalid name",
        ERROR_TITLE: "Error"
    });

    /** Ordered display names for Direct bot opponents.*/
    static DIRECT_OPPONENT_NAMES = Object.freeze(["CM", "XC", "VI"]);

    /** Default rooms available in Direct and Hosted registries.*/
    static DEFAULT_ROOMS = Object.freeze([
        Object.freeze({ roomName: "Default-S0", playerLimit: 4, botCount: 3 }),
        Object.freeze({ roomName: "Default-S1", playerLimit: 4, botCount: 2 }),
        Object.freeze({ roomName: "Default-S2", playerLimit: 4, botCount: 1 })
    ]);

    /** Emoji groups used by room messages. */
    static EMOJIS = Object.freeze({
        silly: this.#createEmojiGroup(["😈", "😂", "😝", "🙃", "🤪"])
    });

    /**
     * Creates an immutable emoji group with random selection.
     *
     * @param {string[]} emojis - Emoji values.
     * @returns {{values:readonly string[], readonly random:string}} Emoji group.
     */
    static #createEmojiGroup(emojis) {
        const values = Object.freeze([...emojis]);
        return Object.freeze({
            values,
            get random() {
                return values[Math.floor(Math.random() * values.length)];
            }
        });
    }

    /** @type {Readonly<Record<string,string>>} Canonical request command names accepted by Host and Game. */
    static COMMANDS = Object.freeze({
        LIST: "list",
        CREATE: "create",
        VIEW: "view",
        JOIN: "join",
        LEAVE: "leave",
        START: "start",
        DRAW: "draw",
        PASS: "pass",
        DISCARD: "discard",
        RETURN: "return",
        DECLARE: "declare"
    });

    /** Returns the Pick 2 score for a validated card identity. */
    static getCardScore(value, suit) {
        let score = Constants.getCardValue(value).rank;

        if (value === Constants.CARD.VALUE.JOKER.id) {
            score = Constants.CARD.SCORE.JOKER;
        } else if (value === Constants.CARD.VALUE.TWO.id) {
            score = Constants.CARD.SCORE.TWO;
        } else if (value === Constants.CARD.VALUE.SEVEN.id && suit === Constants.CARD.SUIT.HEARTS) {
            score = Constants.CARD.SCORE.SEVEN_OF_HEARTS;
        } else if (value === Constants.CARD.VALUE.ACE.id && suit === Constants.CARD.SUIT.SPADES) {
            score = Constants.CARD.SCORE.ACE_OF_SPADES;
        }

        return score;
    }

    /** @type {Readonly<Object>} Canonical card scores, values, suits, deck membership, and sort options. */
    static CARD = Object.freeze({
        SCORE: Object.freeze({ TWO: 20, SEVEN_OF_HEARTS: 30, JOKER: 40, ACE_OF_SPADES: 50 }),

        /** Available card sorting options.*/
        SORT_OPTIONS: Object.freeze(["none", "score", "rank", "value", "suit"]),

        /** Card values and their natural rank. */
        VALUE: Object.freeze({
            TWO: Object.freeze({ id: "2", rank: 2 }),
            THREE: Object.freeze({ id: "3", rank: 3 }),
            FOUR: Object.freeze({ id: "4", rank: 4 }),
            FIVE: Object.freeze({ id: "5", rank: 5 }),
            SIX: Object.freeze({ id: "6", rank: 6 }),
            SEVEN: Object.freeze({ id: "7", rank: 7 }),
            EIGHT: Object.freeze({ id: "8", rank: 8 }),
            NINE: Object.freeze({ id: "9", rank: 9 }),
            TEN: Object.freeze({ id: "10", rank: 10 }),
            JACK: Object.freeze({ id: "j", rank: 11 }),
            QUEEN: Object.freeze({ id: "q", rank: 12 }),
            KING: Object.freeze({ id: "k", rank: 13 }),
            ACE: Object.freeze({ id: "a", rank: 14 }),
            JOKER: Object.freeze({ id: "joker", rank: 15 })
        }),

        /** Card suits. */
        SUIT: Object.freeze({
            CLUBS: "clubs",
            DIAMONDS: "diamonds",
            HEARTS: "hearts",
            SPADES: "spades",

            BLACK: "black",
            RED: "red"
        }),

        /** Standard suits used by non-joker cards.*/
        STANDARD_SUITS: Object.freeze(["clubs", "diamonds", "hearts", "spades"]),

        /** Suits reserved for joker cards. */
        JOKER_SUITS: Object.freeze(["black", "red"]),

        /** Values used by standard, non-joker cards. */
        STANDARD_VALUES: Object.freeze(["2", "3", "4", "5", "6", "7", "8", "9", "10", "j", "q", "k", "a"])
    });

    /**
     * Checks whether a value identifies a standard non-joker suit.
     *
     * @param {*} suit - Value to inspect.
     * @returns {boolean} Whether the value is a standard suit.
     */
    static isStandardSuit(suit) {
        return Constants.CARD.STANDARD_SUITS.includes(suit);
    }

    /**
     * Checks whether a value identifies a joker suit.
     *
     * @param {*} suit - Value to inspect.
     * @returns {boolean} Whether the value is a joker suit.
     */
    static isJokerSuit(suit) {
        return Constants.CARD.JOKER_SUITS.includes(suit);
    }

    /**
     * Normalizes and validates a standard non-joker suit.
     *
     * @param {*} value - Suit value.
     * @returns {string} Normalized standard suit.
     * @throws {Error} When the value is not a standard suit.
     */
    static normalizeStandardSuit(value) {
        const suit = typeof value === "string" ? value.trim().toLowerCase() : "";

        if (!Constants.isStandardSuit(suit)) {
            throw new Error(`Invalid suit: ${suit}`);
        }

        return suit;
    }

    /**
     * Resolves an immutable value definition by its canonical card identifier.
     *
     * @param {string} id - Card value id.
     * @returns {{id:string, rank:number}}
     * @throws {Error} When the identifier does not match a configured card value.
     */
    static getCardValue(id) {
        let cardValue = null;

        for (const card of Object.values(Constants.CARD.VALUE)) {
            if (card.id === id) {
                cardValue = card;
                break;
            }
        }

        if (cardValue === null) {
            throw new Error(`Invalid card value: ${id}`);
        }

        return cardValue;
    }
}
