import { DeviceAvatar } from './DeviceAvatar';
import { DeviceTag } from './DeviceTag';
export function Recipients({
  devices,
  selected,
  onChange,
  encrypted = false,
  disabled = false,
}: {
  devices: {
    id: string;
    name: string;
    platform: string;
    online: boolean;
    publicKey?: string | null;
  }[];
  selected: string[];
  onChange: (ids: string[]) => void;
  encrypted?: boolean;
  disabled?: boolean;
}) {
  const sorted = [...devices].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'zh-CN'),
  );
  return (
    <fieldset className="delivery-recipients">
      <legend>接收设备 · 可多选</legend>
      {sorted.map((d) => (
        <label key={d.id} data-device-id={d.id}>
          <input
            type="checkbox"
            checked={selected.includes(d.id)}
            disabled={disabled || (encrypted && !d.publicKey)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...selected, d.id] : selected.filter((id) => id !== d.id),
              )
            }
          />
          <DeviceAvatar id={d.id} name={d.name} size={28} />
          <span>
            {d.name}
            <DeviceTag platform={d.platform} />
            <small>
              {d.online ? '在线' : '离线'}
              {encrypted && !d.publicKey ? ' · 尚未登记公钥' : ''}
            </small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
export function ReceiveBuffer({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="receive-buffer">
      接收缓冲时间<small>上传完成后开始计时</small>
      <div>
        <input
          aria-label="接收缓冲分钟数"
          type="number"
          min={10}
          max={1440}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span>分钟</span>
      </div>
      <div className="buffer-presets">
        {[10, 60, 360, 1440].map((n) => (
          <button type="button" key={n} aria-pressed={value === n} onClick={() => onChange(n)}>
            {n < 60 ? `${n}分钟` : `${n / 60}小时`}
          </button>
        ))}
      </div>
    </label>
  );
}
