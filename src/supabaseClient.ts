import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://puxbetrtwngjtjowwjmp.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1eGJldHJ0d25nanRqb3d3am1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxNDY4NjcsImV4cCI6MjA5OTcyMjg2N30.J0K_uK4ql8sJ7ruBz3PeaO7mnmBAt4FEreaZNwpD92Y';

export const isSupabaseConfigured = !!(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

