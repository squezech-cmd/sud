"""Windows GUI for an SSH SOCKS5 tunnel. Requires a user-controlled SSH server."""
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import tkinter as tk
from tkinter import messagebox, ttk


class App:
    def __init__(self, root):
        self.root = root
        self.process = None
        self.generation = 0
        root.title('Прокси для Telegram')
        root.resizable(False, False)
        root.protocol('WM_DELETE_WINDOW', self.close)
        frame = ttk.Frame(root, padding=20)
        frame.grid(sticky='nsew')
        ttk.Label(frame, text='Подключение к Telegram', font=('Segoe UI', 16, 'bold')).grid(row=0, column=0, columnspan=2, sticky='w')
        ttk.Label(frame, text='Нужен собственный доступный SSH-сервер.').grid(row=1, column=0, columnspan=2, sticky='w', pady=(4, 12))
        self.fields = {}
        for row, (name, default) in enumerate((('Адрес сервера', ''), ('Пользователь SSH', ''), ('Порт SSH', '22'), ('Локальный порт SOCKS5', '1080')), start=2):
            ttk.Label(frame, text=name).grid(row=row, column=0, sticky='w', pady=4)
            entry = ttk.Entry(frame, width=32)
            entry.insert(0, default)
            entry.grid(row=row, column=1, pady=4, padx=(12, 0))
            self.fields[name] = entry
        self.status = tk.StringVar(value='Отключено')
        ttk.Label(frame, textvariable=self.status, wraplength=400).grid(row=6, column=0, columnspan=2, sticky='w', pady=12)
        self.button = ttk.Button(frame, text='Подключить', command=self.connect)
        self.button.grid(row=7, column=0, sticky='ew')
        ttk.Button(frame, text='Отключить', command=self.disconnect).grid(row=7, column=1, sticky='ew', padx=(12, 0))
        ttk.Label(frame, text='В Telegram: Настройки → Продвинутые настройки →\nТип подключения → SOCKS5. Сервер: 127.0.0.1,\nпорт — указанный выше; логин и пароль пустые.', wraplength=410).grid(row=8, column=0, columnspan=2, sticky='w', pady=(16, 0))

    def connect(self):
        if self.process is not None:
            return
        server = self.fields['Адрес сервера'].get().strip()
        user = self.fields['Пользователь SSH'].get().strip()
        try:
            ssh_port = int(self.fields['Порт SSH'].get())
            local_port = int(self.fields['Локальный порт SOCKS5'].get())
            if not (1 <= ssh_port <= 65535 and 1 <= local_port <= 65535):
                raise ValueError
        except ValueError:
            messagebox.showerror('Ошибка', 'Порты должны быть числами от 1 до 65535.')
            return
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]*', server) or not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_.-]*', user):
            messagebox.showerror('Ошибка', 'Укажите IPv4-адрес или домен сервера и корректное имя пользователя SSH.')
            return
        ssh = shutil.which('ssh.exe' if os.name == 'nt' else 'ssh')
        if not ssh:
            messagebox.showerror('Ошибка', 'Не найден OpenSSH Client. Установите его в дополнительных компонентах Windows.')
            return
        # Reject an already occupied port, rather than reporting an unrelated listener as our proxy.
        try:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', local_port))
        except OSError:
            messagebox.showerror('Ошибка', 'Локальный порт занят. Выберите другой.')
            return
        cmd = [ssh, '-N', '-D', f'127.0.0.1:{local_port}', '-p', str(ssh_port), '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', f'{user}@{server}']
        messagebox.showinfo('Проверка сервера', 'В открывшемся окне SSH подтвердите ключ только после проверки его отпечатка по доверенному каналу. При необходимости введите пароль или парольную фразу ключа.')
        try:
            flags = subprocess.CREATE_NEW_CONSOLE if os.name == 'nt' else 0
            self.process = subprocess.Popen(cmd, creationflags=flags)
        except OSError as exc:
            messagebox.showerror('Ошибка запуска SSH', str(exc))
            return
        self.generation += 1
        generation, process = self.generation, self.process
        self.button.configure(state='disabled')
        self.status.set('Подключение… Проверьте окно SSH.')
        threading.Thread(target=self.monitor, args=(process, generation, local_port), daemon=True).start()

    def monitor(self, process, generation, local_port):
        connected = False
        while process.poll() is None:
            if not connected:
                try:
                    with socket.create_connection(('127.0.0.1', local_port), timeout=0.3):
                        connected = True
                    self.root.after(0, self.update_status, generation, f'Прокси запущен: 127.0.0.1:{local_port}. Настройте Telegram ниже.')
                except OSError:
                    pass
            time.sleep(0.5)
        self.root.after(0, self.finished, generation, process.returncode)

    def update_status(self, generation, text):
        if generation == self.generation:
            self.status.set(text)

    def finished(self, generation, code):
        if generation == self.generation:
            self.process = None
            self.button.configure(state='normal')
            self.status.set(f'SSH завершён (код {code}). Проверьте доступ к серверу и данные входа.')

    def disconnect(self):
        self.generation += 1
        process, self.process = self.process, None
        if process is not None and process.poll() is None:
            process.terminate()
        self.button.configure(state='normal')
        self.status.set('Отключено')

    def close(self):
        self.disconnect()
        self.root.destroy()


if __name__ == '__main__':
    root = tk.Tk()
    App(root)
    root.mainloop()
