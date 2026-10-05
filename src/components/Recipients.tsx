import { useEffect, useMemo, useState } from 'react';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { DeviceAvatar } from './DeviceAvatar';
import { DeviceTag } from './DeviceTag';
interface RecipientDevice {
  id: string;
  name: string;
  platform: string;
  online: boolean;
  publicKey?: string | null;
}
export function Recipients({
  devices,
  selected,
  onChange,
  encrypted = false,
  disabled = false,
  fixedIds = [],
  preserveOrder = false,
}: {
  devices: RecipientDevice[];
  selected: string[];
  onChange: (ids: string[]) => void;
  encrypted?: boolean;
  disabled?: boolean;
  fixedIds?: string[];
  preserveOrder?: boolean;
}) {
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [page, setPage] = useState(0);
  const pageSize = 4;
  const selectionLimit = encrypted ? 255 : 256;
  const selectedCount = selected.filter((id) => !fixedIds.includes(id)).length;
  const filtered = useMemo(
    () =>
      devices
        .filter(
          (d) =>
            (filter === 'all' || (filter === 'online' ? d.online : !d.online)) &&
            d.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        )
        .sort(
          (a, b) =>
            Number(b.online) - Number(a.online) ||
            (preserveOrder ? 0 : a.name.localeCompare(b.name, 'zh-CN')),
        ),
    [devices, query, filter, preserveOrder],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize)),
    currentPage = Math.min(page, totalPages - 1);
  useEffect(() => setPage(0), [query, filter]);
  const selectable = filtered.filter(
    (d) => !fixedIds.includes(d.id) && (!encrypted || d.publicKey),
  );
  const allSelected = selectable.length > 0 && selectable.every((d) => selected.includes(d.id));
  const invalid = selected.filter(
    (id) =>
      !fixedIds.includes(id) && !devices.some((d) => d.id === id && (!encrypted || d.publicKey)),
  );
  return (
    <fieldset className="delivery-recipients">
      <legend>
        接收设备 · 已选 {selectedCount} 台{fixedIds.length ? ' · 含发送者' : ''}
      </legend>
      <div className="recipient-tools">
        <label className="recipient-search">
          <Search size={15} />
          <input
            aria-label="搜索接收设备"
            placeholder="搜索设备名称"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="接收设备在线筛选"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">全部</option>
          <option value="online">在线</option>
          <option value="offline">离线</option>
        </select>
      </div>
      {invalid.length > 0 && (
        <p className="error-text">
          {invalid.length} 台设备已失效
          <button
            type="button"
            onClick={() => onChange(selected.filter((id) => !invalid.includes(id)))}
          >
            移除
          </button>
        </p>
      )}
      <div className="recipient-page">
        {filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((d) => (
          <label key={d.id} data-device-id={d.id}>
            <input
              type="checkbox"
              checked={selected.includes(d.id) || fixedIds.includes(d.id)}
              disabled={
                disabled ||
                fixedIds.includes(d.id) ||
                (encrypted && !d.publicKey) ||
                (!selected.includes(d.id) && selectedCount >= selectionLimit)
              }
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...new Set([...selected, d.id])]
                    : selected.filter((id) => id !== d.id),
                )
              }
            />
            <DeviceAvatar id={d.id} name={d.name} size={28} />
            <span>
              {d.name}
              <DeviceTag platform={d.platform} />
              <small>
                {d.online ? '在线' : '离线'}
                {fixedIds.includes(d.id) ? ' · 本机，固定包含' : ''}
                {encrypted && !d.publicKey ? ' · 尚未登记公钥' : ''}
              </small>
            </span>
          </label>
        ))}
        {!filtered.length && <p className="subtle">没有符合条件的设备</p>}
      </div>
      <div className="recipient-pagination">
        <button
          type="button"
          disabled={disabled || !selectable.length}
          onClick={() =>
            onChange(
              allSelected
                ? selected.filter((id) => !selectable.some((d) => d.id === id))
                : [
                    ...selected,
                    ...selectable
                      .filter((d) => !selected.includes(d.id))
                      .slice(0, Math.max(0, selectionLimit - selectedCount))
                      .map((d) => d.id),
                  ],
            )
          }
        >
          {allSelected ? '取消筛选结果' : '全选筛选结果'}
        </button>
        <span>
          {filtered.length} 台 · {currentPage + 1}/{totalPages}
        </span>
        <button
          type="button"
          aria-label="接收设备上一页"
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          aria-label="接收设备下一页"
          disabled={currentPage + 1 >= totalPages}
          onClick={() => setPage(currentPage + 1)}
        >
          <ChevronRight size={15} />
        </button>
      </div>
      {selectedCount >= selectionLimit && (
        <p className="subtle">每次最多选择 {selectionLimit} 台接收设备，可分批发送</p>
      )}
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
        <div className="buffer-presets">
          {[10, 60, 360, 1440].map((n) => (
            <button type="button" key={n} aria-pressed={value === n} onClick={() => onChange(n)}>
              {n < 60 ? `${n}分钟` : `${n / 60}小时`}
            </button>
          ))}
        </div>
      </div>
    </label>
  );
}
