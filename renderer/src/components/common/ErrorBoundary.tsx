import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

// 局部错误边界:某个子树崩溃时显示错误信息,而不是整窗黑屏
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary]', error)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <div className="error-title">😵 这里出错了</div>
          <pre className="error-detail">{this.state.error.message}</pre>
          <button className="btn" onClick={this.reset}>
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
