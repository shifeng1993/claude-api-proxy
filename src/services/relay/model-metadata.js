export function mapAnthropicModelsToOpenAI(modelsData) {
    const items = Array.isArray(modelsData?.data) ? modelsData.data : [];
    return {
        object: 'list',
        data: items.map((model) => ({
            id: model.id,
            object: 'model',
            created: model.created_at ? Math.floor(new Date(model.created_at).getTime() / 1000) : 0,
            owned_by: model.display_name || model.type || 'anthropic'
        }))
    };
}

export function mapOpenAIModelsToAnthropic(modelsData) {
    return {
        data: (modelsData?.data || []).map((model) => ({
            id: model.id,
            object: 'model',
            created: model.created || 0,
            owned_by: model.owned_by || model.owner || 'relay',
            name: model.id,
            capabilities: {}
        })),
        object: 'list'
    };
}

export function getAnthropicRequestHeaders(req) {
    return {
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        ...(req.headers['anthropic-beta'] ? {'anthropic-beta': req.headers['anthropic-beta']} : {})
    };
}
