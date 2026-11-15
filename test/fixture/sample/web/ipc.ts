declare function invoke(cmd: string): Promise<void>;

export function save(): Promise<void> {
  return invoke("save_note");
}

export function load(): Promise<void> {
  return invoke("load_note");
}
