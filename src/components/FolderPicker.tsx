import { Tooltip } from './Tooltip';
import { CircleHelp } from 'lucide-react';
import {
  startPreparation,
  preparationProgress,
  finishPreparation,
  type PreparationTask,
} from '../preparation';
import { useState, useEffect, useRef } from 'react';
import { FolderArchive } from 'lucide-react';
import type { NativeFile } from '../../electron/nativeFiles';
export function asNativeFile(info: NativeFile) {
  const file = new File([], info.name, { lastModified: info.lastModified });
  Object.defineProperty(file, 'size', { value: info.size });
  Object.defineProperty(file, 'nativeId', { value: info.nativeId });
  return file;
}
export function FolderPicker({
  onPicked,
  onError,
  disabled = false,
  stationId = '',
}: {
  onPicked: (file: File) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  stationId?: string;
}) {
  const task = useRef<PreparationTask | null>(null),
    nativeId = useRef('');
  const [busy, setBusy] = useState(false),
    [stage, setStage] = useState('');
  useEffect(() => {
    if (!window.relay3) return;
    return window.relay3.onNativeProgress((e) => {
      if (!task.current) return;
      nativeId.current = e.id;
      setStage(e.stage);
      preparationProgress(task.current, e.stage, e.bytes, e.total);
      if (task.current.controller.signal.aborted) void window.relay3!.cancelNative(e.id);
    });
  }, []);
  if (!window.relay3) return null;
  return (
    <div className="folder-picker">
      <button
        type="button"
        className="button"
        disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          setStage('扫描文件夹');
          const t = startPreparation(stationId, '文件夹准备', 0);
          task.current = t;
          t.controller.signal.addEventListener(
            'abort',
            () => {
              if (nativeId.current) void window.relay3!.cancelNative(nativeId.current);
            },
            { once: true },
          );
          try {
            const info = await window.relay3!.pickFolderFile();
            if (info) onPicked(asNativeFile(info));
            finishPreparation(t);
            preparationProgress(t, info ? '文件夹已准备好' : '已取消选择');
          } catch (e: any) {
            finishPreparation(t, e.message);
            onError(e.message);
          } finally {
            task.current = null;
            nativeId.current = '';
            setBusy(false);
          }
        }}
      >
        <FolderArchive size={16} />
        {busy ? stage : '选择文件夹（自动 ZIP）'}
      </button>
      <Tooltip text="保留目录结构，接收后自行解压。群聊只加密 ZIP 名称，内部路径和内容不加密。">
        <CircleHelp size={14} />
      </Tooltip>
    </div>
  );
}
