import { Action } from 'vs/base/common/actions';
import { ACTION_ID_FLASH_MANGER_FLASH_ALL, ACTION_LABEL_FLASH_MANGER_FLASH_ALL } from 'vs/kendryte/vs/workbench/flashManager/common/type';
import { FlashTargetType, SerialLoader } from 'vs/kendryte/vs/platform/serialPort/flasher/node/flasher';
import { ISerialPortService } from 'vs/kendryte/vs/services/serialPort/common/type';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IChannelLogger, IChannelLogService } from 'vs/kendryte/vs/services/channelLogger/common/type';
import { KFLASH_CHANNEL, KFLASH_CHANNEL_TITLE } from 'vs/kendryte/vs/base/common/messages';
import { CHIP_BAUDRATE } from 'vs/kendryte/vs/platform/serialPort/flasher/common/chipDefine';
import { INodePathService } from 'vs/kendryte/vs/services/path/common/type';
import { lstat } from 'vs/base/node/pfs';
import { CONFIG_KEY_FLASH_SERIAL_BAUDRATE } from 'vs/kendryte/vs/base/common/configKeys';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IProgress, IProgressService, IProgressStep, ProgressLocation } from 'vs/platform/progress/common/progress';
import { SubProgress } from 'vs/kendryte/vs/platform/config/common/progress';
import { parseMemoryAddress } from 'vs/kendryte/vs/platform/serialPort/flasher/common/memoryAllocationCalculator';
import { createReadStream } from 'fs';
import { IFlashManagerService } from 'vs/kendryte/vs/workbench/flashManager/common/flashManagerService';
import { IKendryteWorkspaceService } from 'vs/kendryte/vs/services/workspace/common/type';
import { IDisposable } from 'vs/base/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { CONFIG_KEY_SUPER_FLASH_ENABLE } from 'vs/kendryte/vs/services/makefileService/superFlash/common/type';
import { FastLoader } from 'vs/kendryte/vs/platform/serialPort/fastFlasher/node/fastLoader';
import { canceled } from 'vs/base/common/errors';

interface IMySection {
	name: string;
	filepath: string;
	startHex: string;
	start: number;
	swapBytes: boolean;
	size: number;
}

export class FlashAllAction extends Action {
	static readonly ID = ACTION_ID_FLASH_MANGER_FLASH_ALL;
	static readonly LABEL = ACTION_LABEL_FLASH_MANGER_FLASH_ALL;
	private readonly logger: IChannelLogger;
	private readonly bootLoader: string;
	private model: IDisposable;

	constructor(
		id = FlashAllAction.ID, label = FlashAllAction.LABEL,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISerialPortService private readonly serialPortService: ISerialPortService,
		@IChannelLogService private readonly channelLogService: IChannelLogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@INodePathService private readonly nodePathService: INodePathService,
		@IFlashManagerService private readonly flashManagerService: IFlashManagerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IProgressService private readonly progressService: IProgressService,
		@IKendryteWorkspaceService private readonly kendryteWorkspaceService: IKendryteWorkspaceService,
	) {
		super(id, label);
		this.logger = channelLogService.createChannel(KFLASH_CHANNEL_TITLE, KFLASH_CHANNEL);
		this.bootLoader = this.nodePathService.getPackagesPath('isp/bootloader.bin'); // todo
	}

	async real_run(path: string | any, report: IProgress<IProgressStep>, token: CancellationToken) {
		let rootPath = '';
		if (typeof path === 'string') {
			rootPath = path;
		} else {
			rootPath = this.kendryteWorkspaceService.requireCurrentWorkspaceFile();
		}
		const model = this.model = await this.flashManagerService.getFlashManagerModel(rootPath);

		const sections: IMySection[] = (await model.createSections()).map((item) => {
			return {
				name: item.varName,
				filepath: item.filepath,
				startHex: item.startHex,
				start: parseMemoryAddress(item.startHex),
				size: item.size,
				swapBytes: item.swapBytes,
			};
		});
		sections.forEach((item) => {
			this.logger.info(` -- [${item.name}] ${item.startHex}`);
			this.logger.info(`    ${item.filepath}`);
		});

		await this.serialPortService.refreshDevices();
		const sel = this.serialPortService.lastSelect || await this.serialPortService.quickOpenDevice();
		if (!sel) {
			return;
		}
		const mgr = this.serialPortService.getPortManager(sel);

		const br = parseInt(this.configurationService.getValue(CONFIG_KEY_FLASH_SERIAL_BAUDRATE)) || CHIP_BAUDRATE;
		this.logger.info('Will use baudrate while flash: ' + br + ' (init port with ' + CHIP_BAUDRATE + ')');

		this.logger.info('==================================');

		const abortedPromise = new Promise<never>((resolve, reject) => {
			token.onCancellationRequested(() => {
				reject(canceled());
			});
		});
		const rep = this._register(new SubProgress('loading...', report));

		if (this.configurationService.getValue<boolean>(CONFIG_KEY_SUPER_FLASH_ENABLE)) {
			this.logger.info(`Try fast flash, Opening serial port ${sel}:`);
			const port = this._register(await mgr.openPort({
				dataBits: 8,
				parity: 'even',
				stopBits: 2,
				baudRate: br,
			}, true));
			this.logger.info(' - OK');

			const loader = new FastLoader(
				this.instantiationService,
				this.serialPortService,
				port,
				this.logger,
				token,
				!this.environmentService.isBuilt,
			);
			this._register(loader);

			const success = await this.fastFlashProgress(
				loader, sections, rep, abortedPromise,
			);
			if (success) {
				return;
			}
			port.dispose();
		}

		this.logger.info(`Fast flash failed, fallback to normal isp, re-opening serial port ${sel}:`);
		const port = this._register(await mgr.openPort({
			dataBits: 8,
			parity: 'none',
			stopBits: 1,
			baudRate: CHIP_BAUDRATE,
		}, true));

		this.logger.info('BootLoader:');
		this.logger.info(`\t${this.bootLoader}`);
		const bootLoaderSize = (await lstat(this.bootLoader)).size;
		this.logger.info(`\t${bootLoaderSize} bytes`);

		const loader = new SerialLoader(
			this.instantiationService,
			this.serialPortService,
			port,
			this.logger,
			token,
			!this.environmentService.isBuilt,
		);
		this._register(loader);

		loader.setBaudRate(br);
		loader.setBootLoader(this.bootLoader);
		loader.setFlashTarget(FlashTargetType.InChip);

		return this.flashProgress(
			loader, sections, bootLoaderSize, rep, abortedPromise,
		);
	}

	async run(path: string | any): Promise<void> {
		const cancel = new CancellationTokenSource();
		await this.progressService.withProgress(
			{
				location: ProgressLocation.Notification,
				title: `Flash program`,
				total: 100,
				cancellable: true,
				source: 'kflash.js',
			},
			(report) => {
				return this.real_run(path, report, cancel.token);
			},
			() => {
				cancel.cancel();
			},
		).then(() => {
			this.logger.info('==================================');
			this.logger.info('Data successfully flashed to the board.');
		}, (e) => {
			this.logger.error('==================================');
			this.logger.error('Flash failed with error: ' + e.message);
			this.channelLogService.show(this.logger.id);
		});
	}

	async fastFlashProgress(flasher: FastLoader, sections: IMySection[], report: SubProgress, abortedPromise: Promise<never>) {
		report.splitWith([
			0, // greeting
			...sections.map(item => item.size),
		]);

		report.message('greeting...');
		const ok: boolean = await Promise.race<any>([abortedPromise, flasher.rebootISPMode()]);
		if (!ok) {
			return false;
		}

		for (const item of sections) {
			report.next();
			this.logger.log(' ');
			this.logger.log('> ' + item.name + ':');
			report.message(`flashing ${item.name} to ${item.startHex}...`);

			try {
				await Promise.race<any>([
					abortedPromise, flasher.flashData(
						createReadStream(item.filepath),
						item.start,
						item.swapBytes,
						report,
					),
				]);
			} catch (e) {
				this.logger.warn('flash failed, will fallback: ', e.message);
				return false;
			}
		}

		return true;
	}

	async flashProgress(flasher: SerialLoader, sections: IMySection[], bootLoaderSize: number, report: SubProgress, abortedPromise: Promise<never>) {
		report.splitWith([
			0, // greeting
			bootLoaderSize, // flash bootloader
			0, // boot
			...sections.map(item => item.size),
		]);

		report.message('greeting...');
		await Promise.race<any>([abortedPromise, flasher.rebootISPMode()]);
		report.next();

		report.message('flashing bootloader...');
		await Promise.race<any>([abortedPromise, flasher.flashBootLoader(report)]);
		report.next();

		report.message('booting up bootloader...');
		await Promise.race<any>([abortedPromise, flasher.executeBootloader(report)]);

		for (const item of sections) {
			report.next();
			this.logger.log(' ');
			this.logger.log('> ' + item.name + ':');
			report.message(`flashing ${item.name} to ${item.startHex}...`);

			await Promise.race<any>([
				abortedPromise, flasher.flashData(
					createReadStream(item.filepath),
					item.start,
					item.swapBytes,
					report,
				),
			]);
		}
	}

	public dispose() {
		super.dispose();
		if (this.model) {
			this.model.dispose();
		}
	}
}
