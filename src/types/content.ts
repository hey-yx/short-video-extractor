// 定义内容相关的类型
export interface ContentInfo {
	title: string;
	author: {
		name: string;
		url: string;
	};
	resources: {
		type: string;
		urls: string[];
	}[];
}

// 定义接口返回值的类型规范
export interface ApiResponse<T> {
	success: boolean; // 请求是否成功
	data: T; // 返回的数据
	message?: string; // 可选的消息
	errorCode?: number; // 可选的错误代码
}
