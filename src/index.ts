import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';
import { WhoopSync } from './sync.js';

interface ToolArguments {
	days?: number;
	full?: boolean;
}

const config = {
	clientId: process.env.WHOOP_CLIENT_ID ?? '',
	clientSecret: process.env.WHOOP_CLIENT_SECRET ?? '',
	redirectUri: process.env.WHOOP_REDIRECT_URI ?? 'http://localhost:3000/callback',
	dbPath: process.env.DB_PATH ?? './whoop.db',
	port: Number.parseInt(process.env.PORT ?? '3000', 10),
	mode: process.env.MCP_MODE ?? 'http',
};

const db = new WhoopDatabase(config.dbPath);
const client = new WhoopClient({
	clientId: config.clientId,
	clientSecret: config.clientSecret,
	redirectUri: config.redirectUri,
	onTokenRefresh: tokens => db.saveTokens(tokens),
});

const existingTokens = db.getTokens();
if (existingTokens) {
	client.setTokens(existingTokens);
	process.stderr.write(`[whoop] Loaded token from DB. Expires: ${new Date(existingTokens.expires_at).toISOString()}\n`);
} else {
	process.stderr.write('[whoop] No existing token found in DB\n');
}

const sync = new WhoopSync(client, db);

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const transports = new Map<string, { transport: StreamableHTTPServerTransport; lastAccess: number }>();

function cleanupStaleSessions(): void {
	const now = Date.now();
	for (const [sessionId, session] of transports) {
		if (now - session.lastAccess > SESSION_TTL_MS) {
			session.transport.close().catch(() => {});
			transports.delete(sessionId);
		}
	}
}

setInterval(cleanupStaleSessions, 5 * 60 * 1000);

function formatDuration(millis: number | null): string {
	if (!millis) return 'N/A';
	const hours = Math.floor(millis / 3_600_000);
	const minutes = Math.floor((millis % 3_600_000) / 60_000);
	return `${hours}h ${minutes}m`;
}

function formatDurationOrZero(millis: number | null | undefined): string {
	const ms = millis ?? 0;
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	return `${hours}h ${minutes}m`;
}

function formatMinutes(millis: number): string {
	const minutes = Math.round(millis / 60_000);
	return `${minutes}m`;
}

function formatTimeWindow(startIso: string, endIso: string): string {
	const start = new Date(startIso);
	const end = new Date(endIso);
	const options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
	return `${start.toLocaleTimeString('en-US', options)} – ${end.toLocaleTimeString('en-US', options)}`;
}

function formatDate(isoString: string): string {
	return new Date(isoString).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
}

function getRecoveryZone(score: number): string {
	if (score >= 67) return 'Green (Well Recovered)';
	if (score >= 34) return 'Yellow (Moderate)';
	return 'Red (Needs Rest)';
}

function getStrainZone(strain: number): string {
	if (strain >= 18) return 'All Out (18-21)';
	if (strain >= 14) return 'High (14-17)';
	if (strain >= 10) return 'Moderate (10-13)';
	return 'Light (0-9)';
}

function validateDays(value: unknown): number {
	if (value === undefined || value === null) return 14;
	const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (Number.isNaN(num) || num < 1) return 14;
	return Math.min(num, 90);
}

function validateBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	return false;
}

function createMcpServer(): Server {
	const server = new Server(
		{ name: 'whoop-mcp-server', version: '1.0.0' },
		{ capabilities: { tools: {} } }
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'get_today',
				description: "Get today's Whoop data including recovery score, last night's sleep, and current strain.",
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'get_recovery_trends',
				description: 'Get recovery score trends over time, including HRV and resting heart rate patterns.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_sleep_analysis',
				description: 'Get detailed sleep analysis including duration, stages, efficiency, and sleep debt.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_strain_history',
				description: 'Get training strain history and workout data.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'sync_data',
				description: 'Manually trigger a data sync from Whoop.',
				inputSchema: {
					type: 'object',
					properties: { full: { type: 'boolean', description: 'Force a full 90-day sync (default: false)' } },
					required: [],
				},
			},
			{
				name: 'get_auth_url',
				description: 'Get the Whoop authorization URL to connect your account.',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'get_nap_data',
				description: 'Get nap data including duration, efficiency, sleep stages, and restorative sleep.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_workout_details',
				description: 'Get detailed workout data including sport, duration, strain, heart rate zones, distance, and calories.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async request => {
		const { name, arguments: args } = request.params;
		const typedArgs = (args ?? {}) as ToolArguments;

		try {
			const dataTools = ['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history', 'get_nap_data', 'get_workout_details'];
			if (dataTools.includes(name)) {
				const tokens = db.getTokens();
				if (!tokens) {
					return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
				}
				client.setTokens(tokens);
				try {
					await sync.smartSync();
				} catch {
					// Continue with cached data
				}
			}

			switch (name) {
				case 'get_today': {
					const recovery = db.getLatestRecovery();
					const sleep = db.getLatestSleep();
					const cycle = db.getTodayCycle() || db.getLatestCycle();
					const nap = db.getTodayNap();
					const todayWorkouts = db.getTodayWorkouts();

					// Fetch body measurement for weight
					let weightLbs: number | null = null;
					try {
						const bodyMeasurement = await client.getBodyMeasurement();
						if (bodyMeasurement?.weight_kilogram) {
							weightLbs = bodyMeasurement.weight_kilogram * 2.20462;
						}
					} catch {
						// Body measurement not available, continue without it
					}

					if (!recovery && !sleep && !cycle) {
						return { content: [{ type: 'text', text: 'No data available. Try running sync_data first.' }] };
					}

					let response = "# Today's Whoop Summary\n\n";

					if (recovery) {
						response += `## Recovery: ${recovery.recovery_score ?? 'N/A'}% ${recovery.recovery_score ? getRecoveryZone(recovery.recovery_score) : ''}\n`;
						response += `- **HRV**: ${recovery.hrv_rmssd?.toFixed(1) ?? 'N/A'} ms\n`;
						response += `- **Resting HR**: ${recovery.resting_hr ?? 'N/A'} bpm\n`;
						if (recovery.spo2) response += `- **SpO2**: ${recovery.spo2.toFixed(1)}%\n`;
						if (recovery.skin_temp) response += `- **Skin Temp**: ${recovery.skin_temp.toFixed(1)}°C\n`;
						if (weightLbs) response += `- **Weight**: ${weightLbs.toFixed(1)} lbs\n`;
						response += '\n';
					}

					if (sleep) {
						const totalInBed = sleep.total_in_bed_milli ?? 0;
						const totalAwake = sleep.total_awake_milli ?? 0;
						const totalSleep = totalInBed - totalAwake;
						const totalLight = sleep.total_light_milli ?? 0;
						const totalDeep = sleep.total_deep_milli ?? 0;
						const totalRem = sleep.total_rem_milli ?? 0;
						const restorative = totalDeep + totalRem;

						// Calculate sleep needed (sum of all components)
						const sleepNeeded = (sleep.sleep_needed_baseline_milli ?? 0) +
							(sleep.sleep_needed_debt_milli ?? 0) +
							(sleep.sleep_needed_strain_milli ?? 0) +
							(sleep.sleep_needed_nap_milli ?? 0);

						response += `## Last Night's Sleep\n`;
						response += `- **Sleep Window**: ${formatTimeWindow(sleep.start_time, sleep.end_time)}\n`;
						response += `- **Total Sleep**: ${formatDuration(totalSleep)}\n`;
						response += `- **Sleep Needed**: ${formatDuration(sleepNeeded)}\n`;
						response += `- **Sleep Debt**: ${formatDurationOrZero(sleep.sleep_needed_debt_milli)}\n`;
						response += `- **Performance**: ${sleep.sleep_performance?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Efficiency**: ${sleep.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Consistency**: ${sleep.sleep_consistency?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Restorative Sleep**: ${formatDuration(restorative)} (Deep + REM)\n`;

						// Stage durations with percentages
						if (totalInBed > 0) {
							const awakePercent = ((totalAwake / totalInBed) * 100).toFixed(0);
							const lightPercent = ((totalLight / totalInBed) * 100).toFixed(0);
							const deepPercent = ((totalDeep / totalInBed) * 100).toFixed(0);
							const remPercent = ((totalRem / totalInBed) * 100).toFixed(0);
							response += `- **Sleep Stages**:\n`;
							response += `  - Awake: ${formatDuration(totalAwake)} (${awakePercent}%)\n`;
							response += `  - Light: ${formatDuration(totalLight)} (${lightPercent}%)\n`;
							response += `  - Deep (SWS): ${formatDuration(totalDeep)} (${deepPercent}%)\n`;
							response += `  - REM: ${formatDuration(totalRem)} (${remPercent}%)\n`;
						}

						if (sleep.disturbance_count != null) response += `- **Wake Events**: ${sleep.disturbance_count}\n`;
						if (sleep.respiratory_rate) response += `- **Respiratory Rate**: ${sleep.respiratory_rate.toFixed(1)} breaths/min\n`;
						response += '\n';
					}

					// Nap data if available
					if (nap) {
						const napInBed = nap.total_in_bed_milli ?? 0;
						const napAwake = nap.total_awake_milli ?? 0;
						const napSleep = napInBed - napAwake;
						const napLight = nap.total_light_milli ?? 0;
						const napDeep = nap.total_deep_milli ?? 0;
						const napRem = nap.total_rem_milli ?? 0;
						const napRestorative = napDeep + napRem;

						response += `## Today's Nap\n`;
						// Time window
						response += `- **Time**: ${formatTimeWindow(nap.start_time, nap.end_time)}\n`;
						response += `- **Duration**: ${formatDuration(napInBed)}\n`;
						response += `- **Hours of Sleep**: ${formatDuration(napSleep)}\n`;
						response += `- **Efficiency**: ${nap.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Restorative Sleep**: ${formatDuration(napRestorative)}\n`;

						// Stage durations with percentages (like nighttime sleep)
						if (napInBed > 0) {
							const awakePercent = ((napAwake / napInBed) * 100).toFixed(0);
							const lightPercent = ((napLight / napInBed) * 100).toFixed(0);
							const deepPercent = ((napDeep / napInBed) * 100).toFixed(0);
							const remPercent = ((napRem / napInBed) * 100).toFixed(0);
							response += `- **Stages**:\n`;
							response += `  - Awake: ${awakePercent}% (${formatMinutes(napAwake)})\n`;
							response += `  - Light: ${lightPercent}% (${formatMinutes(napLight)})\n`;
							response += `  - Deep: ${deepPercent}% (${formatMinutes(napDeep)})\n`;
							response += `  - REM: ${remPercent}% (${formatMinutes(napRem)})\n`;
						}

						// Wake events per hour
						if (nap.disturbance_count != null && napInBed > 0) {
							const napHours = napInBed / 3_600_000;
							const wakesPerHour = nap.disturbance_count / napHours;
							response += `- **Wake Events**: ${nap.disturbance_count} (${wakesPerHour.toFixed(1)} per hour)\n`;
						}

						// Sleep need reduced (from need_from_recent_nap_milli, stored as negative)
						if (nap.sleep_needed_nap_milli) {
							response += `- **Sleep Need Reduced**: ${formatMinutes(Math.abs(nap.sleep_needed_nap_milli))}\n`;
						}
						response += '\n';
					}

					if (cycle) {
						response += `## Current Strain\n`;
						response += `- **Day Strain**: ${cycle.strain?.toFixed(1) ?? 'N/A'} ${cycle.strain ? getStrainZone(cycle.strain) : ''}\n`;
						if (cycle.kilojoule) response += `- **Calories**: ${Math.round(cycle.kilojoule / 4.184)} kcal\n`;
						if (cycle.avg_hr) response += `- **Avg HR**: ${cycle.avg_hr} bpm\n`;
						if (cycle.max_hr) response += `- **Max HR**: ${cycle.max_hr} bpm\n`;
					}

					if (todayWorkouts.length > 0) {
						response += `\n## Today's Workouts (${todayWorkouts.length})\n\n`;
						for (const w of todayWorkouts) {
							const start = new Date(w.start_time);
							const end = new Date(w.end_time);
							const durationMs = end.getTime() - start.getTime();
							const calories = w.kilojoule ? Math.round(w.kilojoule / 4.184) : null;
							const sport = w.sport_name ?? `Sport ${w.sport_id}`;

							response += `### ${sport}\n`;
							response += `- **Time**: ${formatTimeWindow(w.start_time, w.end_time)}\n`;
							response += `- **Duration**: ${formatDuration(durationMs)}\n`;
							if (w.strain) response += `- **Strain**: ${w.strain.toFixed(1)} ${getStrainZone(w.strain)}\n`;
							if (w.avg_hr) response += `- **Avg HR**: ${w.avg_hr} bpm\n`;
							if (w.max_hr) response += `- **Max HR**: ${w.max_hr} bpm\n`;
							if (calories) response += `- **Calories**: ${calories} kcal\n`;
							if (w.distance_meter) response += `- **Distance**: ${(w.distance_meter / 1000).toFixed(2)} km\n`;
						}
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_recovery_trends': {
					const days = validateDays(typedArgs.days);
					const trends = db.getRecoveryTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No recovery data available for the requested period.' }] };
					}

					let response = `# Recovery Trends (Last ${days} Days)\n\n`;
					response += '| Date | Recovery | HRV | RHR |\n|------|----------|-----|-----|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.recovery_score}% | ${day.hrv?.toFixed(1) ?? 'N/A'} ms | ${day.rhr ?? 'N/A'} bpm |\n`;
					}

					const avgRecovery = trends.reduce((sum, d) => sum + (d.recovery_score || 0), 0) / trends.length;
					const avgHrv = trends.reduce((sum, d) => sum + (d.hrv || 0), 0) / trends.length;
					const avgRhr = trends.reduce((sum, d) => sum + (d.rhr || 0), 0) / trends.length;

					response += `\n## Averages\n- **Recovery**: ${avgRecovery.toFixed(0)}%\n- **HRV**: ${avgHrv.toFixed(1)} ms\n- **RHR**: ${avgRhr.toFixed(0)} bpm\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_sleep_analysis': {
					const days = validateDays(typedArgs.days);
					const trends = db.getSleepTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No sleep data available for the requested period.' }] };
					}

					let response = `# Sleep Analysis (Last ${days} Days)\n\n`;
					response += '| Date | Sleep | Needed | Debt | Perf | Eff | Cons | Awake% | Light% | Deep% | REM% | Wakes | RR |\n';
					response += '|------|-------|--------|------|------|-----|------|--------|--------|-------|------|-------|----|\n';

					for (const day of trends) {
						const totalInBed = day.total_in_bed_milli ?? 1;
						const awakePercent = totalInBed > 0 ? ((day.awake_milli ?? 0) / totalInBed * 100).toFixed(0) : 'N/A';
						const lightPercent = totalInBed > 0 ? ((day.light_milli ?? 0) / totalInBed * 100).toFixed(0) : 'N/A';
						const deepPercent = totalInBed > 0 ? ((day.deep_milli ?? 0) / totalInBed * 100).toFixed(0) : 'N/A';
						const remPercent = totalInBed > 0 ? ((day.rem_milli ?? 0) / totalInBed * 100).toFixed(0) : 'N/A';
						const sleepNeededHrs = day.sleep_needed_milli ? (day.sleep_needed_milli / 3600000).toFixed(1) : 'N/A';
						const sleepDebtHrs = day.sleep_debt_milli ? (day.sleep_debt_milli / 3600000).toFixed(1) : '0';

						response += `| ${formatDate(day.date)} | ${day.total_sleep_hours?.toFixed(1) ?? 'N/A'}h | ${sleepNeededHrs}h | ${sleepDebtHrs}h | ${day.performance?.toFixed(0) ?? 'N/A'}% | ${day.efficiency?.toFixed(0) ?? 'N/A'}% | ${day.consistency?.toFixed(0) ?? 'N/A'}% | ${awakePercent}% | ${lightPercent}% | ${deepPercent}% | ${remPercent}% | ${day.disturbance_count ?? 'N/A'} | ${day.respiratory_rate?.toFixed(1) ?? 'N/A'} |\n`;
					}

					// Calculate averages
					const avgDuration = trends.reduce((sum, d) => sum + (d.total_sleep_hours || 0), 0) / trends.length;
					const avgPerf = trends.reduce((sum, d) => sum + (d.performance || 0), 0) / trends.length;
					const avgEff = trends.reduce((sum, d) => sum + (d.efficiency || 0), 0) / trends.length;
					const avgCons = trends.filter(d => d.consistency != null).reduce((sum, d) => sum + (d.consistency || 0), 0) / (trends.filter(d => d.consistency != null).length || 1);
					const avgRestorative = trends.reduce((sum, d) => sum + (d.restorative_milli || 0), 0) / trends.length;
					const avgDebt = trends.reduce((sum, d) => sum + (d.sleep_debt_milli || 0), 0) / trends.length;
					const avgWakes = trends.filter(d => d.disturbance_count != null).reduce((sum, d) => sum + (d.disturbance_count || 0), 0) / (trends.filter(d => d.disturbance_count != null).length || 1);
					const avgRR = trends.filter(d => d.respiratory_rate != null).reduce((sum, d) => sum + (d.respiratory_rate || 0), 0) / (trends.filter(d => d.respiratory_rate != null).length || 1);

					response += `\n## Averages\n`;
					response += `- **Duration**: ${avgDuration.toFixed(1)} hours\n`;
					response += `- **Performance**: ${avgPerf.toFixed(0)}%\n`;
					response += `- **Efficiency**: ${avgEff.toFixed(0)}%\n`;
					response += `- **Consistency**: ${avgCons.toFixed(0)}%\n`;
					response += `- **Restorative Sleep**: ${formatDuration(avgRestorative)} (Deep + REM)\n`;
					response += `- **Sleep Debt**: ${(avgDebt / 3600000).toFixed(1)} hours\n`;
					response += `- **Wake Events**: ${avgWakes.toFixed(1)}\n`;
					response += `- **Respiratory Rate**: ${avgRR.toFixed(1)} breaths/min\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_strain_history': {
					const days = validateDays(typedArgs.days);
					const trends = db.getStrainTrends(days);
					const workouts = db.getWorkoutTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No strain data available for the requested period.' }] };
					}

					let response = `# Strain History (Last ${days} Days)\n\n`;
					response += '| Date | Strain | Zone | Calories | Avg HR | Max HR |\n';
					response += '|------|--------|------|----------|--------|--------|\n';

					for (const day of trends) {
						const zone = day.strain ? getStrainZone(day.strain) : 'N/A';
						response += `| ${formatDate(day.date)} | ${day.strain?.toFixed(1) ?? 'N/A'} | ${zone} | ${day.calories ?? 'N/A'} | ${day.avg_hr ?? 'N/A'} | ${day.max_hr ?? 'N/A'} |\n`;
					}

					const avgStrain = trends.reduce((sum, d) => sum + (d.strain || 0), 0) / trends.length;
					const avgCalories = trends.reduce((sum, d) => sum + (d.calories || 0), 0) / trends.length;
					const avgHr = trends.filter(d => d.avg_hr != null).reduce((sum, d) => sum + (d.avg_hr || 0), 0) / (trends.filter(d => d.avg_hr != null).length || 1);
					const avgMaxHr = trends.filter(d => d.max_hr != null).reduce((sum, d) => sum + (d.max_hr || 0), 0) / (trends.filter(d => d.max_hr != null).length || 1);

					response += `\n## Averages\n`;
					response += `- **Daily Strain**: ${avgStrain.toFixed(1)}\n`;
					response += `- **Daily Calories**: ${Math.round(avgCalories)} kcal\n`;
					response += `- **Avg HR**: ${avgHr.toFixed(0)} bpm\n`;
					response += `- **Avg Max HR**: ${avgMaxHr.toFixed(0)} bpm\n`;

					// Add workout details if any
					if (workouts.length > 0) {
						response += `\n## Workouts (${workouts.length} total)\n\n`;
						response += '| Date | Sport | Time | Duration | Strain | Avg HR | Max HR | Calories | Distance |\n';
						response += '|------|-------|------|----------|--------|--------|--------|----------|----------|\n';

						for (const w of workouts) {
							const start = new Date(w.start_time);
							const end = new Date(w.end_time);
							const durationMs = end.getTime() - start.getTime();
							const calories = w.kilojoule ? Math.round(w.kilojoule / 4.184) : 'N/A';
							const distance = w.distance_meter ? `${(w.distance_meter / 1000).toFixed(2)} km` : 'N/A';
							const sport = w.sport_name ?? `Sport ${w.sport_id}`;

							response += `| ${formatDate(w.start_time)} | ${sport} | ${formatTimeWindow(w.start_time, w.end_time)} | ${formatDuration(durationMs)} | ${w.strain?.toFixed(1) ?? 'N/A'} | ${w.avg_hr ?? 'N/A'} | ${w.max_hr ?? 'N/A'} | ${calories} | ${distance} |\n`;
						}
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'sync_data': {
					const tokens = db.getTokens();
					if (!tokens) {
						return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
					}
					client.setTokens(tokens);

					const full = validateBoolean(typedArgs.full);
					let stats;

					if (full) {
						stats = await sync.syncDays(90);
					} else {
						const result = await sync.smartSync();
						if (result.type === 'skip') {
							return { content: [{ type: 'text', text: 'Data is already up to date (synced within the last hour).' }] };
						}
						stats = result.stats;
					}

					return {
						content: [{
							type: 'text',
							text: `Sync complete!\n- Cycles: ${stats?.cycles}\n- Recoveries: ${stats?.recoveries}\n- Sleeps: ${stats?.sleeps}\n- Workouts: ${stats?.workouts}`,
						}],
					};
				}

				case 'get_auth_url': {
					const scopes = ['read:profile', 'read:body_measurement', 'read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline'];
					const url = client.getAuthorizationUrl(scopes);
					return {
						content: [{
							type: 'text',
							text: `To authorize with Whoop:\n\n1. Visit: ${url}\n2. Log in and authorize\n3. You'll be redirected back automatically\n\nRedirect URI: ${config.redirectUri}`,
						}],
					};
				}

				case 'get_nap_data': {
					const days = validateDays(typedArgs.days);
					const naps = db.getNapTrends(days);

					if (naps.length === 0) {
						return { content: [{ type: 'text', text: `No nap data available for the last ${days} days.` }] };
					}

					let response = `# Nap Data (Last ${days} Days)\n\n`;
					response += `Found **${naps.length}** naps\n\n`;
					response += '| Date | Duration | Sleep | Eff | Restorative | Awake% | Light% | Deep% | REM% | Wakes | Need Reduced |\n';
					response += '|------|----------|-------|-----|-------------|--------|--------|-------|------|-------|-------------|\n';

					for (const nap of naps) {
						const totalInBed = nap.total_in_bed_milli ?? 1;
						const awakePercent = totalInBed > 0 ? ((nap.awake_milli ?? 0) / totalInBed * 100).toFixed(0) : 'N/A';
						const lightPercent = totalInBed > 0 ? ((nap.light_milli ?? 0) / totalInBed * 100).toFixed(0) : 'N/A';
						const deepPercent = totalInBed > 0 ? ((nap.deep_milli ?? 0) / totalInBed * 100).toFixed(0) : 'N/A';
						const remPercent = totalInBed > 0 ? ((nap.rem_milli ?? 0) / totalInBed * 100).toFixed(0) : 'N/A';
						const restorativeHrs = nap.restorative_milli ? (nap.restorative_milli / 3600000).toFixed(1) : '0';
						const needReduced = nap.sleep_needed_milli ? formatDuration(Math.abs(nap.sleep_needed_milli)) : 'N/A';

						response += `| ${formatDate(nap.date)} | ${formatDuration(totalInBed)} | ${nap.total_sleep_hours?.toFixed(1) ?? 'N/A'}h | ${nap.efficiency?.toFixed(0) ?? 'N/A'}% | ${restorativeHrs}h | ${awakePercent}% | ${lightPercent}% | ${deepPercent}% | ${remPercent}% | ${nap.disturbance_count ?? 'N/A'} | ${needReduced} |\n`;
					}

					// Calculate averages
					const avgDuration = naps.reduce((sum, n) => sum + (n.total_in_bed_milli || 0), 0) / naps.length;
					const avgSleep = naps.reduce((sum, n) => sum + (n.total_sleep_hours || 0), 0) / naps.length;
					const avgEff = naps.filter(n => n.efficiency != null).reduce((sum, n) => sum + (n.efficiency || 0), 0) / (naps.filter(n => n.efficiency != null).length || 1);
					const avgRestorative = naps.reduce((sum, n) => sum + (n.restorative_milli || 0), 0) / naps.length;

					response += `\n## Averages\n`;
					response += `- **Duration**: ${formatDuration(avgDuration)}\n`;
					response += `- **Sleep**: ${avgSleep.toFixed(1)} hours\n`;
					response += `- **Efficiency**: ${avgEff.toFixed(0)}%\n`;
					response += `- **Restorative**: ${formatDuration(avgRestorative)}\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_workout_details': {
					const days = validateDays(typedArgs.days);
					const workouts = db.getWorkoutTrends(days);

					if (workouts.length === 0) {
						return { content: [{ type: 'text', text: `No workout data available for the last ${days} days.` }] };
					}

					let response = `# Workout Details (Last ${days} Days)\n\n`;
					response += `Found **${workouts.length}** workouts\n\n`;

					for (const w of workouts) {
						const start = new Date(w.start_time);
						const end = new Date(w.end_time);
						const durationMs = end.getTime() - start.getTime();
						const calories = w.kilojoule ? Math.round(w.kilojoule / 4.184) : null;
						const sport = w.sport_name ?? `Sport ID ${w.sport_id}`;

						response += `### ${formatDate(w.start_time)} - ${sport}\n`;
						response += `- **Time**: ${formatTimeWindow(w.start_time, w.end_time)}\n`;
						response += `- **Duration**: ${formatDuration(durationMs)}\n`;
						response += `- **Strain**: ${w.strain?.toFixed(1) ?? 'N/A'} ${w.strain ? getStrainZone(w.strain) : ''}\n`;
						response += `- **Avg HR**: ${w.avg_hr ?? 'N/A'} bpm\n`;
						response += `- **Max HR**: ${w.max_hr ?? 'N/A'} bpm\n`;
						if (calories) response += `- **Calories**: ${calories} kcal\n`;
						if (w.distance_meter) response += `- **Distance**: ${(w.distance_meter / 1000).toFixed(2)} km (${(w.distance_meter * 0.000621371).toFixed(2)} mi)\n`;
						if (w.altitude_gain_meter) response += `- **Elevation Gain**: ${w.altitude_gain_meter.toFixed(0)} m\n`;

						// HR Zone breakdown
						const totalZoneTime = (w.zone_zero_milli ?? 0) + (w.zone_one_milli ?? 0) + (w.zone_two_milli ?? 0) +
							(w.zone_three_milli ?? 0) + (w.zone_four_milli ?? 0) + (w.zone_five_milli ?? 0);

						if (totalZoneTime > 0) {
							response += `- **HR Zones**:\n`;
							if (w.zone_zero_milli) response += `  - Zone 0 (Rest): ${formatDuration(w.zone_zero_milli)} (${((w.zone_zero_milli / totalZoneTime) * 100).toFixed(0)}%)\n`;
							if (w.zone_one_milli) response += `  - Zone 1 (Easy): ${formatDuration(w.zone_one_milli)} (${((w.zone_one_milli / totalZoneTime) * 100).toFixed(0)}%)\n`;
							if (w.zone_two_milli) response += `  - Zone 2 (Moderate): ${formatDuration(w.zone_two_milli)} (${((w.zone_two_milli / totalZoneTime) * 100).toFixed(0)}%)\n`;
							if (w.zone_three_milli) response += `  - Zone 3 (Hard): ${formatDuration(w.zone_three_milli)} (${((w.zone_three_milli / totalZoneTime) * 100).toFixed(0)}%)\n`;
							if (w.zone_four_milli) response += `  - Zone 4 (Very Hard): ${formatDuration(w.zone_four_milli)} (${((w.zone_four_milli / totalZoneTime) * 100).toFixed(0)}%)\n`;
							if (w.zone_five_milli) response += `  - Zone 5 (Max): ${formatDuration(w.zone_five_milli)} (${((w.zone_five_milli / totalZoneTime) * 100).toFixed(0)}%)\n`;
						}

						response += '\n';
					}

					// Summary stats
					const totalStrain = workouts.reduce((sum, w) => sum + (w.strain || 0), 0);
					const avgStrain = totalStrain / workouts.length;
					const totalCalories = workouts.reduce((sum, w) => sum + (w.kilojoule ? w.kilojoule / 4.184 : 0), 0);
					const totalDistance = workouts.reduce((sum, w) => sum + (w.distance_meter || 0), 0);

					response += `## Summary\n`;
					response += `- **Total Workouts**: ${workouts.length}\n`;
					response += `- **Total Strain**: ${totalStrain.toFixed(1)}\n`;
					response += `- **Avg Strain per Workout**: ${avgStrain.toFixed(1)}\n`;
					response += `- **Total Calories**: ${Math.round(totalCalories)} kcal\n`;
					if (totalDistance > 0) response += `- **Total Distance**: ${(totalDistance / 1000).toFixed(2)} km\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
		}
	});

	return server;
}

async function main(): Promise<void> {
	if (config.mode === 'stdio') {
		const server = createMcpServer();
		const transport = new StdioServerTransport();
		await server.connect(transport);
		process.stderr.write('Whoop MCP server running on stdio\n');
	} else {
		const app = express();
		app.use((req, res, next) => { if (req.path === '/mcp') return next(); express.json()(req, res, next); });

		app.get('/callback', async (req: Request, res: Response) => {
			const code = req.query.code as string | undefined;
			if (!code) {
				res.status(400).send('Missing authorization code');
				return;
			}

			try {
				const tokens = await client.exchangeCodeForTokens(code);
				db.saveTokens(tokens);
				sync.syncDays(90).catch(() => {});
				res.send('Authorization successful! You can close this window.');
			} catch {
				res.status(500).send('Authorization failed. Please try again.');
			}
		});

		app.get('/health', (_req: Request, res: Response) => {
			res.json({ status: 'ok', authenticated: Boolean(db.getTokens()) });
		});

		app.all('/mcp', async (req: Request, res: Response) => {
			const sessionId = req.headers['mcp-session-id'] as string | undefined;

			if (req.method === 'DELETE' && sessionId && transports.has(sessionId)) {
				const session = transports.get(sessionId)!;
				await session.transport.close();
				transports.delete(sessionId);
				res.status(200).send('Session closed');
				return;
			}

			if (req.method === 'POST') {
				let transport: StreamableHTTPServerTransport;

				if (sessionId && transports.has(sessionId)) {
				// Existing valid session
					const session = transports.get(sessionId)!;
					session.lastAccess = Date.now();
					transport = session.transport;
				} else if (sessionId) {
					// Client has a stale session ID (e.g. server restarted) — return 404 so it re-initializes
					process.stderr.write(`Session ${sessionId} not found, sending 404 to force re-init\n`);
					res.status(404).json({ error: 'Session not found. Please re-initialize.' });
					return;
				} else {
					// No session ID — fresh connection, create a new session
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => crypto.randomUUID(),
						onsessioninitialized: newSessionId => {
							transports.set(newSessionId, { transport, lastAccess: Date.now() });
							process.stderr.write(`New session created: ${newSessionId}\n`);
						},
					});

					const server = createMcpServer();
					await server.connect(transport);
				}

				await transport.handleRequest(req, res);
				return;
			}

			res.status(405).send('Method not allowed');
		});

		app.get('/sse', (_req: Request, res: Response) => {
			res.status(410).send('SSE endpoint deprecated. Use /mcp with Streamable HTTP transport.');
		});

		const server = app.listen(config.port, '0.0.0.0', () => {
			process.stdout.write(`Whoop MCP server running on http://0.0.0.0:${config.port}\n`);
		});

		const shutdown = (): void => {
			process.stdout.write('\nShutting down...\n');
			for (const [, session] of transports) {
				session.transport.close().catch(() => {});
			}
			transports.clear();
			db.close();
			server.close(() => process.exit(0));
		};

		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);
	}
}

main().catch(error => {
	process.stderr.write(`Fatal error: ${error}\n`);
	process.exit(1);
});
