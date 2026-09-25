// Loaded only by the integration test process before the production entry point.
globalThis.fetch = async input => {
	const url = String(input);
	if (!url.endsWith('/v2/user/measurement/body')) {
		throw new Error(`Unexpected WHOOP request: ${new URL(url).pathname}`);
	}
	if (process.env.TEST_WEIGHT_MODE === 'fail') {
		return new Response('temporary outage', { status: 503 });
	}
	if (process.env.TEST_WEIGHT_MODE === 'invalid') {
		return Response.json({ weight_kilogram: 0 });
	}
	return Response.json({ weight_kilogram: Number(process.env.TEST_WEIGHT_KG ?? '65.68') });
};
