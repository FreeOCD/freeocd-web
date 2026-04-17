// Simple Terminal UI for RTT
// Provides a basic terminal interface without external dependencies

export class Terminal {
    constructor(containerElement, options = {}) {
        this.container = containerElement;
        this.onSend = options.onSend || (() => {});
        this.onClear = options.onClear || (() => {});
        this.onSave = options.onSave || (() => {});
        this.lineBuffer = '';
        this.output = [];
        this.maxOutputLines = options.maxOutputLines || 1000;
    }

    init() {
        this.container.innerHTML = `
            <div class="terminal-container">
                <div class="terminal-toolbar">
                    <button class="btn-terminal-clear" id="terminalClear">Clear</button>
                    <button class="btn-terminal-save" id="terminalSave">Save Log</button>
                    <span class="terminal-buffer-info" id="terminalBufferInfo"></span>
                </div>
                <div class="terminal-output" id="terminalOutput"></div>
                <div class="terminal-input-line">
                    <span class="terminal-prompt">&gt;</span>
                    <input type="text" class="terminal-input" id="terminalInput" autocomplete="off" spellcheck="false" />
                </div>
            </div>
        `;

        this.outputElement = this.container.querySelector('#terminalOutput');
        this.inputElement = this.container.querySelector('#terminalInput');
        this.clearButton = this.container.querySelector('#terminalClear');
        this.saveButton = this.container.querySelector('#terminalSave');
        this.bufferInfoElement = this.container.querySelector('#terminalBufferInfo');

        // Bind events
        this.inputElement.addEventListener('keydown', (e) => this.handleKeyDown(e));
        this.clearButton.addEventListener('click', () => this.clear());
        this.saveButton.addEventListener('click', () => this.saveLog());

        // Focus input on click
        this.container.addEventListener('click', () => {
            this.inputElement.focus();
        });
    }

    handleKeyDown(e) {
        if (e.key === 'Enter') {
            const line = this.inputElement.value;
            if (line.length > 0) {
                this.write(`> ${line}\n`, 'input');
                this.onSend(line + '\n');
                this.inputElement.value = '';
            }
        } else if (e.key === 'Backspace') {
            // Allow default backspace behavior
        }
    }

    write(data, type = 'output') {
        const line = document.createElement('div');
        line.className = `terminal-line terminal-${type}`;
        line.textContent = data;
        this.outputElement.appendChild(line);

        // Keep output buffer limited
        while (this.outputElement.children.length > this.maxOutputLines) {
            this.outputElement.removeChild(this.outputElement.firstChild);
        }

        this.outputElement.scrollTop = this.outputElement.scrollHeight;
    }

    clear() {
        this.outputElement.innerHTML = '';
        this.onClear();
    }

    saveLog() {
        const text = this.outputElement.innerText;
        this.onSave(text);
    }

    updateBufferInfo(info) {
        if (info) {
            const usedPercent = ((info.used / info.SizeOfBuffer) * 100).toFixed(1);
            this.bufferInfoElement.textContent = `Buffer: ${info.used}/${info.SizeOfBuffer} (${usedPercent}%)`;
        } else {
            this.bufferInfoElement.textContent = '';
        }
    }

    focus() {
        this.inputElement.focus();
    }

    enable() {
        this.inputElement.disabled = false;
        this.clearButton.disabled = false;
        this.saveButton.disabled = false;
    }

    disable() {
        this.inputElement.disabled = true;
        this.clearButton.disabled = true;
        this.saveButton.disabled = true;
    }
}
