import Database from 'better-sqlite3';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import type {
	WhoopTokens,
	WhoopCycle,
	WhoopRecovery,
	WhoopSleep,
	WhoopWorkout,
	DbCycle,
	DbRecovery,
	DbSleep,
	DbWorkout,
} from './types.js';

interface TokenRow {
	id: number;
	access_token: string;
	refresh_token: string;
	expires_at: number;
	updated_at: string;
}

interface SyncStateRow {
	id: number;
	last_sync_at: string | null;
	oldest_synced_date: string | null;
	newest_synced_date: string | null;
}

interface RecoveryTrendRow {
	date: string;
	recovery_score: number;
	hrv: number;
	rhr: number;
}

interface SleepTrendRow {
	date: string;
	total_sleep_hours: number;
	performance: number;
	efficiency: number;
	consistency: number | null;
	respiratory_rate: number | null;
	sleep_needed_milli: number | null;
	sleep_debt_milli: number | null;
	restorative_milli: number | null;
	disturbance_count: number | null;
	total_in_bed_milli: number | null;
	awake_milli: number | null;
	light_milli: number | null;
	deep_milli: number | null;
	rem_milli: number | null;
}

interface StrainTrendRow {
	date: string;
	strain: number;
	calories: number;
	avg_hr: number | null;
	max_hr: number | null;
}

export class WhoopDatabase {
	private db: Database.Database;

	constructor(dbPath = './whoop.db') {
		this.db = new Database(dbPath);
		this.db.pragma('journal_mode = WAL');
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS tokens (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				access_token TEXT NOT NULL,
				refresh_token TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS sync_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				last_sync_at TEXT,
				oldest_synced_date TEXT,
				newest_synced_date TEXT
			);

			CREATE TABLE IF NOT EXISTS cycles (
				id INTEGER PRIMARY KEY,
				user_id INTEGER NOT NULL,
				start_time TEXT NOT NULL,
				end_time TEXT,
				score_state TEXT NOT NULL,
				strain REAL,
				kilojoule REAL,
				avg_hr INTEGER,
				max_hr INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS recovery (
				id INTEGER PRIMARY KEY,
				user_id INTEGER NOT NULL,
				sleep_id TEXT,
				created_at TEXT NOT NULL,
				score_state TEXT NOT NULL,
				recovery_score INTEGER,
				resting_hr INTEGER,
				hrv_rmssd REAL,
				spo2 REAL,
				skin_temp REAL,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS sleep (
				id TEXT PRIMARY KEY,
				user_id INTEGER NOT NULL,
				cycle_id INTEGER,
				start_time TEXT NOT NULL,
				end_time TEXT NOT NULL,
				is_nap INTEGER NOT NULL DEFAULT 0,
				score_state TEXT NOT NULL,
				total_in_bed_milli INTEGER,
				total_awake_milli INTEGER,
				total_light_milli INTEGER,
				total_deep_milli INTEGER,
				total_rem_milli INTEGER,
				sleep_performance REAL,
				sleep_efficiency REAL,
				sleep_consistency REAL,
				respiratory_rate REAL,
				sleep_needed_baseline_milli INTEGER,
				sleep_needed_debt_milli INTEGER,
				sleep_needed_strain_milli INTEGER,
				sleep_needed_nap_milli INTEGER,
				disturbance_count INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS workouts (
				id TEXT PRIMARY KEY,
				user_id INTEGER NOT NULL,
				sport_id INTEGER NOT NULL,
				sport_name TEXT,
				start_time TEXT NOT NULL,
				end_time TEXT NOT NULL,
				score_state TEXT NOT NULL,
				strain REAL,
				avg_hr INTEGER,
				max_hr INTEGER,
				kilojoule REAL,
				distance_meter REAL,
				altitude_gain_meter REAL,
				zone_zero_milli INTEGER,
				zone_one_milli INTEGER,
				zone_two_milli INTEGER,
				zone_three_milli INTEGER,
				zone_four_milli INTEGER,
				zone_five_milli INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE INDEX IF NOT EXISTS idx_cycles_start ON cycles(start_time);
			CREATE INDEX IF NOT EXISTS idx_recovery_created ON recovery(created_at);
			CREATE INDEX IF NOT EXISTS idx_sleep_start ON sleep(start_time);
			CREATE INDEX IF NOT EXISTS idx_workouts_start ON workouts(start_time);

			INSERT OR IGNORE INTO sync_state (id) VALUES (1);
		`);

		// Migration: Add new columns to existing tables (if they don't exist)
		this.migrateSchema();
	}

	private migrateSchema(): void {
		// Check and add missing columns to sleep table
		const sleepColumns = this.db.prepare("PRAGMA table_info(sleep)").all() as { name: string }[];
		const sleepColumnNames = sleepColumns.map(c => c.name);

		if (!sleepColumnNames.includes('sleep_needed_nap_milli')) {
			this.db.exec('ALTER TABLE sleep ADD COLUMN sleep_needed_nap_milli INTEGER');
		}
		if (!sleepColumnNames.includes('disturbance_count')) {
			this.db.exec('ALTER TABLE sleep ADD COLUMN disturbance_count INTEGER');
		}

		// Check and add missing columns to workouts table
		const workoutColumns = this.db.prepare("PRAGMA table_info(workouts)").all() as { name: string }[];
		const workoutColumnNames = workoutColumns.map(c => c.name);

		if (!workoutColumnNames.includes('sport_name')) {
			this.db.exec('ALTER TABLE workouts ADD COLUMN sport_name TEXT');
		}
		if (!workoutColumnNames.includes('distance_meter')) {
			this.db.exec('ALTER TABLE workouts ADD COLUMN distance_meter REAL');
		}
		if (!workoutColumnNames.includes('altitude_gain_meter')) {
			this.db.exec('ALTER TABLE workouts ADD COLUMN altitude_gain_meter REAL');
		}
	}

	saveTokens(tokens: WhoopTokens): void {
		const encryptedAccess = encrypt(tokens.access_token);
		const encryptedRefresh = encrypt(tokens.refresh_token);

		this.db.prepare(`
			INSERT OR REPLACE INTO tokens (id, access_token, refresh_token, expires_at, updated_at)
			VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
		`).run(encryptedAccess, encryptedRefresh, tokens.expires_at);
	}

	getTokens(): WhoopTokens | null {
		const row = this.db.prepare('SELECT * FROM tokens WHERE id = 1').get() as TokenRow | undefined;
		if (!row) return null;

		const accessToken = isEncrypted(row.access_token)
			? decrypt(row.access_token)
			: row.access_token;

		const refreshToken = isEncrypted(row.refresh_token)
			? decrypt(row.refresh_token)
			: row.refresh_token;

		return {
			access_token: accessToken,
			refresh_token: refreshToken,
			expires_at: row.expires_at,
		};
	}

	getSyncState(): { lastSyncAt: string | null; oldestDate: string | null; newestDate: string | null } {
		const row = this.db.prepare('SELECT * FROM sync_state WHERE id = 1').get() as SyncStateRow | undefined;
		return {
			lastSyncAt: row?.last_sync_at ?? null,
			oldestDate: row?.oldest_synced_date ?? null,
			newestDate: row?.newest_synced_date ?? null,
		};
	}

	updateSyncState(oldestDate: string, newestDate: string): void {
		this.db.prepare(`
			UPDATE sync_state
			SET last_sync_at = CURRENT_TIMESTAMP,
				oldest_synced_date = COALESCE(
					CASE WHEN oldest_synced_date IS NULL OR ? < oldest_synced_date THEN ? ELSE oldest_synced_date END,
					?
				),
				newest_synced_date = COALESCE(
					CASE WHEN newest_synced_date IS NULL OR ? > newest_synced_date THEN ? ELSE newest_synced_date END,
					?
				)
			WHERE id = 1
		`).run(oldestDate, oldestDate, oldestDate, newestDate, newestDate, newestDate);
	}

	upsertCycles(cycles: WhoopCycle[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO cycles (id, user_id, start_time, end_time, score_state, strain, kilojoule, avg_hr, max_hr, synced_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopCycle[]) => {
			for (const c of items) {
				stmt.run(
					c.id,
					c.user_id,
					c.start,
					c.end,
					c.score_state,
					c.score?.strain ?? null,
					c.score?.kilojoule ?? null,
					c.score?.average_heart_rate ?? null,
					c.score?.max_heart_rate ?? null
				);
			}
		});

		insertMany(cycles);
	}

	upsertRecoveries(recoveries: WhoopRecovery[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO recovery (id, user_id, sleep_id, created_at, score_state, recovery_score, resting_hr, hrv_rmssd, spo2, skin_temp, synced_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopRecovery[]) => {
			for (const r of items) {
				stmt.run(
					r.cycle_id,
					r.user_id,
					r.sleep_id,
					r.created_at,
					r.score_state,
					r.score?.recovery_score ?? null,
					r.score?.resting_heart_rate ?? null,
					r.score?.hrv_rmssd_milli ?? null,
					r.score?.spo2_percentage ?? null,
					r.score?.skin_temp_celsius ?? null
				);
			}
		});

		insertMany(recoveries);
	}

	upsertSleeps(sleeps: WhoopSleep[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO sleep (
				id, user_id, start_time, end_time, is_nap, score_state,
				total_in_bed_milli, total_awake_milli, total_light_milli, total_deep_milli, total_rem_milli,
				sleep_performance, sleep_efficiency, sleep_consistency, respiratory_rate,
				sleep_needed_baseline_milli, sleep_needed_debt_milli, sleep_needed_strain_milli,
				sleep_needed_nap_milli, disturbance_count, synced_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopSleep[]) => {
			for (const s of items) {
				stmt.run(
					s.id,
					s.user_id,
					s.start,
					s.end,
					s.nap ? 1 : 0,
					s.score_state,
					s.score?.stage_summary.total_in_bed_time_milli ?? null,
					s.score?.stage_summary.total_awake_time_milli ?? null,
					s.score?.stage_summary.total_light_sleep_time_milli ?? null,
					s.score?.stage_summary.total_slow_wave_sleep_time_milli ?? null,
					s.score?.stage_summary.total_rem_sleep_time_milli ?? null,
					s.score?.sleep_performance_percentage ?? null,
					s.score?.sleep_efficiency_percentage ?? null,
					s.score?.sleep_consistency_percentage ?? null,
					s.score?.respiratory_rate ?? null,
					s.score?.sleep_needed.baseline_milli ?? null,
					s.score?.sleep_needed.need_from_sleep_debt_milli ?? null,
					s.score?.sleep_needed.need_from_recent_strain_milli ?? null,
					s.score?.sleep_needed.need_from_recent_nap_milli ?? null,
					s.score?.stage_summary.disturbance_count ?? null
				);
			}
		});

		insertMany(sleeps);
	}

	upsertWorkouts(workouts: WhoopWorkout[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO workouts (
				id, user_id, sport_id, sport_name, start_time, end_time, score_state,
				strain, avg_hr, max_hr, kilojoule, distance_meter, altitude_gain_meter,
				zone_zero_milli, zone_one_milli, zone_two_milli, zone_three_milli, zone_four_milli, zone_five_milli,
				synced_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopWorkout[]) => {
			for (const w of items) {
				stmt.run(
					w.id,
					w.user_id,
					w.sport_id,
					w.sport_name ?? null,
					w.start,
					w.end,
					w.score_state,
					w.score?.strain ?? null,
					w.score?.average_heart_rate ?? null,
					w.score?.max_heart_rate ?? null,
					w.score?.kilojoule ?? null,
					w.score?.distance_meter ?? null,
					w.score?.altitude_gain_meter ?? null,
					w.score?.zone_duration?.zone_zero_milli ?? null,
					w.score?.zone_duration?.zone_one_milli ?? null,
					w.score?.zone_duration?.zone_two_milli ?? null,
					w.score?.zone_duration?.zone_three_milli ?? null,
					w.score?.zone_duration?.zone_four_milli ?? null,
					w.score?.zone_duration?.zone_five_milli ?? null
				);
			}
		});

		insertMany(workouts);
	}

	getLatestCycle(): DbCycle | null {
		return this.db.prepare('SELECT * FROM cycles ORDER BY start_time DESC LIMIT 1').get() as DbCycle | undefined ?? null;
	}

	getLatestRecovery(): DbRecovery | null {
		return this.db.prepare('SELECT * FROM recovery ORDER BY created_at DESC LIMIT 1').get() as DbRecovery | undefined ?? null;
	}

	getLatestSleep(): DbSleep | null {
		return this.db.prepare('SELECT * FROM sleep WHERE is_nap = 0 ORDER BY start_time DESC LIMIT 1').get() as DbSleep | undefined ?? null;
	}

	getLatestNap(): DbSleep | null {
		return this.db.prepare('SELECT * FROM sleep WHERE is_nap = 1 ORDER BY start_time DESC LIMIT 1').get() as DbSleep | undefined ?? null;
	}

	getTodayNap(): DbSleep | null {
		// Anchor to the end of the last main sleep (when you woke up today)
		// so naps from a previous WHOOP cycle are never returned
		return this.db.prepare(`
			SELECT * FROM sleep
			WHERE is_nap = 1
			  AND start_time > (
			    SELECT end_time FROM sleep
			    WHERE is_nap = 0
			    ORDER BY start_time DESC
			    LIMIT 1
			  )
			ORDER BY start_time DESC LIMIT 1
		`).get() as DbSleep | undefined ?? null;
	}

	getTodayCycle(): DbCycle | null {
		// Anchor to the end of the last main sleep (when you woke up today)
		// so yesterday's cycle is never returned
		return this.db.prepare(`
			SELECT * FROM cycles
			WHERE start_time > (
			    SELECT end_time FROM sleep
			    WHERE is_nap = 0
			    ORDER BY start_time DESC
			    LIMIT 1
			  )
			ORDER BY start_time DESC LIMIT 1
		`).get() as DbCycle | undefined ?? null;
	}

	getTodayWorkouts(): DbWorkout[] {
		// Anchor to the end of the last main sleep (when you woke up today)
		// so yesterday's workouts are never returned
		return this.db.prepare(`
			SELECT * FROM workouts
			WHERE start_time > (
			    SELECT end_time FROM sleep
			    WHERE is_nap = 0
			    ORDER BY start_time DESC
			    LIMIT 1
			  )
			ORDER BY start_time DESC
		`).all() as DbWorkout[];
	}

	getNapTrends(days: number): SleepTrendRow[] {
		return this.db.prepare(`
			SELECT DATE(start_time, 'localtime') as date,
				ROUND((total_in_bed_milli - total_awake_milli) / 3600000.0, 2) as total_sleep_hours,
				sleep_performance as performance,
				sleep_efficiency as efficiency,
				sleep_consistency as consistency,
				respiratory_rate,
				sleep_needed_nap_milli as sleep_needed_milli,
				sleep_needed_debt_milli as sleep_debt_milli,
				(COALESCE(total_deep_milli, 0) + COALESCE(total_rem_milli, 0)) as restorative_milli,
				disturbance_count,
				total_in_bed_milli,
				total_awake_milli as awake_milli,
				total_light_milli as light_milli,
				total_deep_milli as deep_milli,
				total_rem_milli as rem_milli
			FROM sleep
			WHERE is_nap = 1 AND start_time >= DATE('now', 'localtime', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as SleepTrendRow[];
	}

	getCyclesByDateRange(startDate: string, endDate: string): DbCycle[] {
		return this.db.prepare(`
			SELECT * FROM cycles WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC
		`).all(startDate, endDate) as DbCycle[];
	}

	getRecoveriesByDateRange(startDate: string, endDate: string): DbRecovery[] {
		return this.db.prepare(`
			SELECT * FROM recovery WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC
		`).all(startDate, endDate) as DbRecovery[];
	}

	getSleepsByDateRange(startDate: string, endDate: string, includeNaps = false): DbSleep[] {
		const query = includeNaps
			? 'SELECT * FROM sleep WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC'
			: 'SELECT * FROM sleep WHERE start_time >= ? AND start_time <= ? AND is_nap = 0 ORDER BY start_time DESC';
		return this.db.prepare(query).all(startDate, endDate) as DbSleep[];
	}

	getWorkoutsByDateRange(startDate: string, endDate: string): DbWorkout[] {
		return this.db.prepare(`
			SELECT * FROM workouts WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC
		`).all(startDate, endDate) as DbWorkout[];
	}

	getRecoveryTrends(days: number): RecoveryTrendRow[] {
		return this.db.prepare(`
			SELECT DATE(created_at, 'localtime') as date, recovery_score, hrv_rmssd as hrv, resting_hr as rhr
			FROM recovery
			WHERE recovery_score IS NOT NULL AND created_at >= DATE('now', 'localtime', '-' || ? || ' days')
			ORDER BY created_at DESC
		`).all(days) as RecoveryTrendRow[];
	}

	getSleepTrends(days: number): SleepTrendRow[] {
		return this.db.prepare(`
			SELECT DATE(start_time, 'localtime') as date,
				ROUND((total_in_bed_milli - total_awake_milli) / 3600000.0, 2) as total_sleep_hours,
				sleep_performance as performance,
				sleep_efficiency as efficiency,
				sleep_consistency as consistency,
				respiratory_rate,
				(COALESCE(sleep_needed_baseline_milli, 0) + COALESCE(sleep_needed_debt_milli, 0) + COALESCE(sleep_needed_strain_milli, 0) + COALESCE(sleep_needed_nap_milli, 0)) as sleep_needed_milli,
				sleep_needed_debt_milli as sleep_debt_milli,
				(COALESCE(total_deep_milli, 0) + COALESCE(total_rem_milli, 0)) as restorative_milli,
				disturbance_count,
				total_in_bed_milli,
				total_awake_milli as awake_milli,
				total_light_milli as light_milli,
				total_deep_milli as deep_milli,
				total_rem_milli as rem_milli
			FROM sleep
			WHERE is_nap = 0 AND sleep_performance IS NOT NULL AND start_time >= DATE('now', 'localtime', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as SleepTrendRow[];
	}

	getStrainTrends(days: number): StrainTrendRow[] {
		return this.db.prepare(`
			SELECT DATE(start_time, 'localtime') as date, strain, ROUND(kilojoule / 4.184, 0) as calories, avg_hr, max_hr
			FROM cycles
			WHERE strain IS NOT NULL AND start_time >= DATE('now', 'localtime', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as StrainTrendRow[];
	}

	getWorkoutTrends(days: number): DbWorkout[] {
		return this.db.prepare(`
			SELECT * FROM workouts
			WHERE start_time >= DATE('now', 'localtime', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as DbWorkout[];
	}

	close(): void {
		this.db.close();
	}
}
