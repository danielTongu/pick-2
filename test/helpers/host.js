import { Constants } from "../../core/Constants.js";

/** Connects one tab and returns only responses emitted during each request. */
export function createConnection(host, tabId = "test-tab") {
    const responses = [];
    const connection = host.accept(response => responses.push(response), () => {});
    return {
        connection,
        responses,
        async request(command, data = {}) {
            const offset = responses.length;
            await connection.receive({ command, data: { tabId, sortKey: "none", ...data } });
            return responses.slice(offset);
        }
    };
}

/** Retrieves the latest authoritative Room snapshot from a response batch. */
export function latestGame(responses) {
    return responses.findLast(response => response.view === Constants.VIEWS.ROOM)?.data;
}
