// 自动上传备份：配置存取 + 到期判断。
// 真正的上传由 OSContext 里的调度器调用 cloudBackupToWebDAV()，
// 这里只放纯逻辑，方便单测，也避免把定时器塞进设置页。

export type AutoBackupMode = 'text_only' | 'full';

export interface AutoBackupConfig {
    enabled: boolean;
    /** 间隔分钟数，范围 20 ~ 1440（24 小时） */
    intervalMinutes: number;
    mode: AutoBackupMode;
    /** 上次自动备份成功的时间戳 */
    lastRunAt?: number;
}

export const AUTO_BACKUP_STORAGE_KEY = 'sully_auto_backup_v1';
export const AUTO_BACKUP_MIN_MINUTES = 20;
export const AUTO_BACKUP_MAX_MINUTES = 24 * 60;

const DEFAULT_CONFIG: AutoBackupConfig = {
    enabled: false,
    intervalMinutes: 60,
    mode: 'text_only',
};

export const clampAutoBackupMinutes = (value: unknown): number => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return DEFAULT_CONFIG.intervalMinutes;
    return Math.min(AUTO_BACKUP_MAX_MINUTES, Math.max(AUTO_BACKUP_MIN_MINUTES, Math.round(num)));
};

export const normalizeAutoBackupConfig = (raw: unknown): AutoBackupConfig => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
    const input = raw as Partial<AutoBackupConfig>;
    const lastRunAt = typeof input.lastRunAt === 'number' && Number.isFinite(input.lastRunAt) && input.lastRunAt > 0
        ? input.lastRunAt
        : undefined;
    return {
        enabled: input.enabled === true,
        intervalMinutes: clampAutoBackupMinutes(input.intervalMinutes),
        mode: input.mode === 'full' ? 'full' : 'text_only',
        lastRunAt,
    };
};

export const loadAutoBackupConfig = (storage?: Pick<Storage, 'getItem'>): AutoBackupConfig => {
    try {
        const area = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
        if (!area) return { ...DEFAULT_CONFIG };
        const text = area.getItem(AUTO_BACKUP_STORAGE_KEY);
        if (!text) return { ...DEFAULT_CONFIG };
        return normalizeAutoBackupConfig(JSON.parse(text));
    } catch {
        return { ...DEFAULT_CONFIG };
    }
};

export const saveAutoBackupConfig = (
    config: AutoBackupConfig,
    storage?: Pick<Storage, 'setItem'>,
): AutoBackupConfig => {
    const next = normalizeAutoBackupConfig(config);
    try {
        const area = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
        area?.setItem(AUTO_BACKUP_STORAGE_KEY, JSON.stringify(next));
    } catch {
        // 配额满时静默：下次读到的还是旧配置，不会把定时器搞崩。
    }
    return next;
};

/** 是否到了该自动备份的时间。没跑过就算到期。 */
export const autoBackupDue = (config: AutoBackupConfig, now: number = Date.now()): boolean => {
    if (!config.enabled) return false;
    if (!config.lastRunAt) return true;
    return now - config.lastRunAt >= config.intervalMinutes * 60 * 1000;
};

export const formatAutoBackupInterval = (minutes: number): string => {
    const value = clampAutoBackupMinutes(minutes);
    if (value < 60) return `${value} 分钟`;
    const hours = value / 60;
    if (Number.isInteger(hours)) return `${hours} 小时`;
    return `${hours.toFixed(1)} 小时`;
};

// 滑块用 0~100 的对数刻度：20 分钟到 24 小时跨 72 倍，
// 线性滑块会把前几个小时全挤在左边一小段。
const LOG_MIN = Math.log(AUTO_BACKUP_MIN_MINUTES);
const LOG_MAX = Math.log(AUTO_BACKUP_MAX_MINUTES);

export const sliderToAutoBackupMinutes = (slider: number): number => {
    const t = Math.min(100, Math.max(0, slider)) / 100;
    const value = Math.exp(LOG_MIN + (LOG_MAX - LOG_MIN) * t);
    return clampAutoBackupMinutes(value);
};

export const autoBackupMinutesToSlider = (minutes: number): number => {
    const value = clampAutoBackupMinutes(minutes);
    const t = (Math.log(value) - LOG_MIN) / (LOG_MAX - LOG_MIN);
    return Math.round(Math.min(1, Math.max(0, t)) * 100);
};
