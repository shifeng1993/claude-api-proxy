import {
    createChatToAnthropicStreamBridge as defaultCreateChatToAnthropicStreamBridge,
    createResponsesToChatStreamBridge as defaultCreateResponsesToChatStreamBridge
} from './protocol-adapter.js';

export function writeRelayAnthropicEvent(res, event) {
    if (!res || res.writableEnded || res.destroyed) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function streamRelayResponsesEventsAsAnthropic(
    eventStream,
    res,
    signal,
    responsesAccumulator = null,
    {
        createResponsesToChatStreamBridge = defaultCreateResponsesToChatStreamBridge,
        createChatToAnthropicStreamBridge = defaultCreateChatToAnthropicStreamBridge,
        writeAnthropicEvent = writeRelayAnthropicEvent
    } = {}
) {
    const responsesToChatBridge = createResponsesToChatStreamBridge();
    const chatToAnthropicBridge = createChatToAnthropicStreamBridge();
    let usage = null;

    for await (const event of eventStream) {
        if (signal?.aborted) break;
        if (event.type === 'response.completed') {
            usage = event.data?.response?.usage || usage;
        }
        if (responsesAccumulator) responsesAccumulator.feed(event.type, event.data);
        const chatChunks = responsesToChatBridge.feed(event.type, event.data);
        for (const chatChunk of chatChunks) {
            const anthropicEvents = chatToAnthropicBridge.feed(chatChunk);
            for (const anthropicEvent of anthropicEvents) {
                writeAnthropicEvent(res, anthropicEvent);
            }
        }
        if (res.writableNeedDrain) {
            await new Promise(resolve => res.once('drain', resolve));
        }
    }

    return usage;
}
