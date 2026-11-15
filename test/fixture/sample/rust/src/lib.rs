mod geo;

#[wasm_bindgen(js_name = tangentAt)]
pub fn tangent_at_js(x: f64) -> f64 {
    geo::tangent(x)
}

#[tauri::command]
pub fn save_note() {}

#[tauri::command]
pub fn idle_command() {}
