import * as SunCalc from 'suncalc';
import type { CSSProperties } from 'react';

// ==========================================
// CONFIGURACIÓN Y CONSTANTES DEL AMBIENTE
// ==========================================

export const ZITACUARO_COORDS = {
  latitude: 19.4361,
  longitude: -100.3578,
  cityName: 'Zitácuaro, Michoacán, México',
  timezoneOffsetHours: -6, // UTC-6 hora estándar en Zitácuaro
};

export type TimeOfDay = 'sunrise' | 'sunny' | 'sunset' | 'night';
export type WeatherType =
  | 'clear'
  | 'partly_cloudy'
  | 'cloudy'
  | 'light_rain'
  | 'rain'
  | 'storm';

export interface AmbientState {
  timeOfDay: TimeOfDay;
  weather: WeatherType;
  backgroundStyle: CSSProperties;
  showStars: boolean;
  showRain: boolean;
  rainDensity: 'light' | 'normal' | 'heavy';
  isDark: boolean;
}

// Colores y degradados base para el ciclo solar
export const AMBIENT_STYLES = {
  sunrise: {
    background: 'linear-gradient(135deg, #fce7f3 0%, #fed7aa 50%, #fef08a 100%)',
  },
  sunny: {
    background: '#ffffff',
  },
  sunset: {
    background: 'linear-gradient(135deg, #fed7aa 0%, #fca5a5 50%, #fbcfe8 100%)',
  },
  night: {
    background: 'linear-gradient(180deg, #0d131f 0%, #172033 100%)',
  },
  // Modificadores de clima
  partlyCloudyOverlayDay: 'rgba(235, 238, 243, 0.4)',
  partlyCloudyOverlayNight: 'rgba(15, 20, 30, 0.25)',
  cloudyDay: '#f0f2f5',
  cloudyNight: '#1a2230',
  stormDarkenOverlay: 'rgba(0, 0, 0, 0.32)',
};

// Configuración de Estrellas (Noche)
export const STARS_CONFIG = {
  count: 45,
  minSizePx: 1,
  maxSizePx: 2.5,
  minOpacity: 0.2,
  maxOpacity: 0.85,
  minTwinkleDurationSec: 2.5,
  maxTwinkleDurationSec: 5.0,
};

// Configuración de Lluvia
export const RAIN_CONFIG = {
  lightCount: 22,
  normalCount: 48,
  stormCount: 75,
  minDurationSec: 0.65,
  maxDurationSec: 1.15,
  minHeightPx: 14,
  maxHeightPx: 28,
  angleDeg: 12,
  lightColor: 'rgba(180, 210, 240, 0.35)',
  normalColor: 'rgba(170, 205, 240, 0.50)',
  stormColor: 'rgba(145, 185, 230, 0.65)',
};

// Intervalo de verificación del ambiente (1 minuto)
export const CHECK_INTERVAL_MS = 60000;

// ==========================================
// CÁLCULOS ASTRONÓMICOS Y DETERMINISTAS
// ==========================================

/**
 * Obtiene la fecha/hora actual convertida al horario local de Zitácuaro (UTC-6)
 */
export function getZitacuaroDate(date: Date = new Date()): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  minuteOfDay: number;
} {
  // Convertir a tiempo UTC y aplicar offset de Zitácuaro
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000;
  const zitacuaroMs = utcMs + ZITACUARO_COORDS.timezoneOffsetHours * 3600000;
  const zDate = new Date(zitacuaroMs);

  const year = zDate.getUTCFullYear();
  const month = zDate.getUTCMonth();
  const day = zDate.getUTCDate();
  const hours = zDate.getUTCHours();
  const minutes = zDate.getUTCMinutes();
  const minuteOfDay = hours * 60 + minutes;

  return { year, month, day, hours, minutes, minuteOfDay };
}

/**
 * Calcula el momento del ciclo solar para Zitácuaro, Michoacán
 */
export function calculateTimeOfDay(date: Date = new Date()): TimeOfDay {
  const times = SunCalc.getTimes(date, ZITACUARO_COORDS.latitude, ZITACUARO_COORDS.longitude);

  const nowMs = date.getTime();
  const sunriseMs = times.sunrise.getTime();
  const sunsetMs = times.sunset.getTime();
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

  if (nowMs >= sunriseMs && nowMs < sunriseMs + TWO_HOURS_MS) {
    return 'sunrise';
  } else if (nowMs >= sunriseMs + TWO_HOURS_MS && nowMs < sunsetMs - TWO_HOURS_MS) {
    return 'sunny';
  } else if (nowMs >= sunsetMs - TWO_HOURS_MS && nowMs < sunsetMs) {
    return 'sunset';
  } else {
    return 'night';
  }
}

/**
 * Generador pseudoaleatorio Mulberry32 determinista por semilla
 */
function createPRNG(seed: number) {
  let a = seed | 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface WeatherBlock {
  startMinute: number;
  endMinute: number;
  weather: WeatherType;
}

/**
 * Genera el cronograma meteorológico completo para un día específico de Zitácuaro.
 * Cada día tiene una secuencia diferente, duraciones variables y transiciones naturales.
 */
export function generateDailyWeatherSchedule(year: number, month: number, day: number): WeatherBlock[] {
  // Semilla única por día
  const seed = year * 10000 + (month + 1) * 100 + day + 777;
  const rand = createPRNG(seed);

  // Determinar el arquetipo climático del día:
  // 55% día completamente seco (despejado / parcialmente nublado)
  // 35% día con chubasco ocasional (lluvia ligera o lluvia breve)
  // 10% día lluvioso / tormentoso
  const dayTypeRoll = rand();
  const isDryDay = dayTypeRoll < 0.55;
  const isWetDay = dayTypeRoll >= 0.90;

  const blocks: WeatherBlock[] = [];
  let currentMinute = 0;
  let currentWeather: WeatherType = rand() < 0.7 ? 'clear' : 'partly_cloudy';

  while (currentMinute < 1440) {
    // Duración variable entre 25 y 85 minutos
    const duration = Math.floor(25 + rand() * 60);
    const endMinute = Math.min(1440, currentMinute + duration);

    blocks.push({
      startMinute: currentMinute,
      endMinute,
      weather: currentWeather,
    });

    currentMinute = endMinute;

    // Transición lógica según el estado actual y el arquetipo del día
    const step = rand();
    if (isDryDay) {
      if (currentWeather === 'clear') {
        currentWeather = step < 0.4 ? 'partly_cloudy' : 'clear';
      } else {
        currentWeather = step < 0.65 ? 'clear' : 'partly_cloudy';
      }
    } else if (isWetDay) {
      if (currentWeather === 'clear') {
        currentWeather = step < 0.5 ? 'partly_cloudy' : 'clear';
      } else if (currentWeather === 'partly_cloudy') {
        currentWeather = step < 0.45 ? 'cloudy' : step < 0.75 ? 'clear' : 'partly_cloudy';
      } else if (currentWeather === 'cloudy') {
        currentWeather = step < 0.4 ? 'light_rain' : step < 0.7 ? 'rain' : 'partly_cloudy';
      } else if (currentWeather === 'light_rain') {
        currentWeather = step < 0.5 ? 'rain' : 'cloudy';
      } else if (currentWeather === 'rain') {
        currentWeather = step < 0.25 ? 'storm' : step < 0.65 ? 'light_rain' : 'cloudy';
      } else if (currentWeather === 'storm') {
        currentWeather = 'rain';
      }
    } else {
      // Día moderado estándar (lluvia ligera ocasional)
      if (currentWeather === 'clear') {
        currentWeather = step < 0.45 ? 'partly_cloudy' : 'clear';
      } else if (currentWeather === 'partly_cloudy') {
        currentWeather = step < 0.35 ? 'cloudy' : step < 0.75 ? 'clear' : 'partly_cloudy';
      } else if (currentWeather === 'cloudy') {
        currentWeather = step < 0.3 ? 'light_rain' : step < 0.7 ? 'partly_cloudy' : 'cloudy';
      } else if (currentWeather === 'light_rain') {
        currentWeather = step < 0.2 ? 'rain' : 'cloudy';
      } else if (currentWeather === 'rain') {
        currentWeather = 'light_rain';
      } else {
        currentWeather = 'rain';
      }
    }
  }

  return blocks;
}

/**
 * Obtiene el clima determinista para la fecha/hora actual
 */
export function calculateDeterministicWeather(date: Date = new Date()): WeatherType {
  const { year, month, day, minuteOfDay } = getZitacuaroDate(date);
  const schedule = generateDailyWeatherSchedule(year, month, day);

  const currentBlock = schedule.find(
    (b) => minuteOfDay >= b.startMinute && minuteOfDay < b.endMinute
  );

  return currentBlock ? currentBlock.weather : 'clear';
}

/**
 * Obtiene el estado completo del ambiente combinando ciclo solar y clima
 */
export function getAmbientState(date: Date = new Date()): AmbientState {
  const timeOfDay = calculateTimeOfDay(date);
  const weather = calculateDeterministicWeather(date);

  const isNight = timeOfDay === 'night';
  const isRain = weather === 'light_rain' || weather === 'rain' || weather === 'storm';
  const isStorm = weather === 'storm';

  let bgStyle: CSSProperties = {};
  const baseBg = AMBIENT_STYLES[timeOfDay].background;

  switch (weather) {
    case 'clear':
      bgStyle = { background: baseBg };
      break;

    case 'partly_cloudy':
      if (timeOfDay === 'sunny') {
        bgStyle = {
          background: `linear-gradient(${AMBIENT_STYLES.partlyCloudyOverlayDay}, ${AMBIENT_STYLES.partlyCloudyOverlayDay}), ${baseBg}`,
        };
      } else if (isNight) {
        bgStyle = {
          background: `linear-gradient(${AMBIENT_STYLES.partlyCloudyOverlayNight}, ${AMBIENT_STYLES.partlyCloudyOverlayNight}), ${baseBg}`,
        };
      } else {
        bgStyle = { background: baseBg };
      }
      break;

    case 'cloudy':
      bgStyle = {
        background: isNight ? AMBIENT_STYLES.cloudyNight : AMBIENT_STYLES.cloudyDay,
      };
      break;

    case 'light_rain':
    case 'rain':
      if (timeOfDay === 'sunny') {
        bgStyle = { background: AMBIENT_STYLES.cloudyDay };
      } else {
        bgStyle = { background: baseBg };
      }
      break;

    case 'storm':
      bgStyle = {
        background: `linear-gradient(${AMBIENT_STYLES.stormDarkenOverlay}, ${AMBIENT_STYLES.stormDarkenOverlay}), ${
          isNight ? AMBIENT_STYLES.cloudyNight : AMBIENT_STYLES.cloudyDay
        }`,
      };
      break;
  }

  const rainDensity: 'light' | 'normal' | 'heavy' =
    weather === 'light_rain' ? 'light' : weather === 'storm' ? 'heavy' : 'normal';

  return {
    timeOfDay,
    weather,
    backgroundStyle: bgStyle,
    showStars: isNight && (weather === 'clear' || weather === 'partly_cloudy'),
    showRain: isRain,
    rainDensity,
    isDark: isNight || isStorm,
  };
}

// Generador de semillas pseudo-aleatorias deterministas para estrellas y gotas
export function pseudoRandom(seed: number) {
  const x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}
