import * as SunCalc from 'suncalc';
import type { CSSProperties } from 'react';

// ==========================================
// CONFIGURACIÓN Y CONSTANTES DEL AMBIENTE
// ==========================================

export const ZITACUARO_COORDS = {
  latitude: 19.4361,
  longitude: -100.3578,
  cityName: 'Zitácuaro, Michoacán, México',
};

export type TimeOfDay = 'sunrise' | 'sunny' | 'sunset' | 'night';
export type WeatherType = 'clear' | 'cloudy' | 'rain' | 'storm';

export interface AmbientState {
  timeOfDay: TimeOfDay;
  weather: WeatherType;
  backgroundStyle: CSSProperties;
  showStars: boolean;
  showRain: boolean;
  isDark: boolean;
}

// Colores y degradados
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
  cloudy: {
    background: '#f0f2f5',
  },
  stormDarkenOverlay: 'rgba(0, 0, 0, 0.25)',
};

// Configuración de Estrellas (Noche)
export const STARS_CONFIG = {
  count: 45,
  minSizePx: 1,
  maxSizePx: 2.5,
  minOpacity: 0.2,
  maxOpacity: 0.8,
  minTwinkleDurationSec: 2.5,
  maxTwinkleDurationSec: 5.0,
};

// Configuración de Lluvia
export const RAIN_CONFIG = {
  count: 50,
  minDurationSec: 0.7,
  maxDurationSec: 1.2,
  minHeightPx: 15,
  maxHeightPx: 28,
  angleDeg: 12,
  color: 'rgba(180, 210, 240, 0.45)',
  stormColor: 'rgba(150, 180, 220, 0.55)',
};

// Intervalo de verificación del ambiente (1 minuto)
export const CHECK_INTERVAL_MS = 60000;

// Ventana de cambio de clima en horas (3 horas) para mantener clima consistente para todos los usuarios
export const WEATHER_WINDOW_HOURS = 3;

// ==========================================
// CÁLCULOS ASTRONÓMICOS Y DETERMINISTAS
// ==========================================

/**
 * Calcula el momento del día para Zitácuaro, Michoacán
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
 * Genera el clima de forma completamente determinista para la hora actual.
 * De esta forma, todos los usuarios en el mundo ven exactamente el mismo clima a la misma hora.
 */
export function calculateDeterministicWeather(date: Date = new Date()): WeatherType {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const windowIndex = Math.floor(date.getHours() / WEATHER_WINDOW_HOURS);

  // Hash determinista simple
  const seedStr = `${year}-${month}-${day}-${windowIndex}-zitacuaro`;
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash << 5) - hash + seedStr.charCodeAt(i);
    hash |= 0;
  }
  const normalized = (Math.abs(hash) % 1000) / 1000;

  // Probabilidades: 70% despejado, 15% nublado, 10% lluvia, 5% tormenta
  if (normalized < 0.70) {
    return 'clear';
  } else if (normalized < 0.85) {
    return 'cloudy';
  } else if (normalized < 0.95) {
    return 'rain';
  } else {
    return 'storm';
  }
}

/**
 * Obtiene el estado completo del ambiente
 */
export function getAmbientState(date: Date = new Date()): AmbientState {
  const timeOfDay = calculateTimeOfDay(date);
  const weather = calculateDeterministicWeather(date);

  const isNight = timeOfDay === 'night';
  const isCloudy = weather === 'cloudy';
  const isRain = weather === 'rain';
  const isStorm = weather === 'storm';

  let bgStyle: CSSProperties = {};

  if (isCloudy) {
    bgStyle = { background: AMBIENT_STYLES.cloudy.background };
  } else {
    bgStyle = { background: AMBIENT_STYLES[timeOfDay].background };
  }

  // Si es tormenta, agregamos una capa sutilmente más oscura sobre el fondo
  if (isStorm) {
    bgStyle = {
      ...bgStyle,
      backgroundImage: `linear-gradient(${AMBIENT_STYLES.stormDarkenOverlay}, ${AMBIENT_STYLES.stormDarkenOverlay}), ${
        bgStyle.background || AMBIENT_STYLES[timeOfDay].background
      }`,
    };
  }

  return {
    timeOfDay,
    weather,
    backgroundStyle: bgStyle,
    showStars: isNight && !isCloudy && !isStorm,
    showRain: isRain || isStorm,
    isDark: isNight || isStorm,
  };
}

// Generador de semillas pseudo-aleatorias deterministas para estrellas y gotas
export function pseudoRandom(seed: number) {
  const x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}
