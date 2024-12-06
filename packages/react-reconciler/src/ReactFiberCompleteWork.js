/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber, FiberRoot} from './ReactInternalTypes';
import type {RootState} from './ReactFiberRoot';
import type {Lanes, Lane} from './ReactFiberLane';
import type {ReactScopeInstance, ReactContext} from 'shared/ReactTypes';
import type {
  Instance,
  Type,
  Props,
  Container,
  ChildSet,
  Resource,
} from './ReactFiberConfig';
import type {
  SuspenseState,
  SuspenseListRenderState,
  RetryQueue,
} from './ReactFiberSuspenseComponent';
import type {
  OffscreenState,
  OffscreenQueue,
} from './ReactFiberActivityComponent';
import {isOffscreenManual} from './ReactFiberActivityComponent';
import type {TracingMarkerInstance} from './ReactFiberTracingMarkerComponent';
import type {Cache} from './ReactFiberCacheComponent';
import {
  enableLegacyHidden,
  enableSuspenseCallback,
  enableScopeAPI,
  enablePersistedModeClonedFlag,
  enableProfilerTimer,
  enableCache,
  enableTransitionTracing,
  enableRenderableContext,
  passChildrenWhenCloningPersistedNodes,
  disableLegacyMode,
  enableSiblingPrerendering,
} from 'shared/ReactFeatureFlags';

import {now} from './Scheduler';

import {
  FunctionComponent,
  ClassComponent,
  HostRoot,
  HostComponent,
  HostHoistable,
  HostSingleton,
  HostText,
  HostPortal,
  ContextProvider,
  ContextConsumer,
  ForwardRef,
  Fragment,
  Mode,
  Profiler,
  SuspenseComponent,
  SuspenseListComponent,
  MemoComponent,
  SimpleMemoComponent,
  LazyComponent,
  IncompleteClassComponent,
  IncompleteFunctionComponent,
  ScopeComponent,
  OffscreenComponent,
  LegacyHiddenComponent,
  CacheComponent,
  TracingMarkerComponent,
  Throw,
} from './ReactWorkTags';
import {NoMode, ConcurrentMode, ProfileMode} from './ReactTypeOfMode';
import {
  Placement,
  Update,
  Visibility,
  NoFlags,
  DidCapture,
  Snapshot,
  ChildDeletion,
  StaticMask,
  MutationMask,
  Passive,
  ForceClientRender,
  MaySuspendCommit,
  ScheduleRetry,
  ShouldSuspendCommit,
  Cloned,
} from './ReactFiberFlags';

import {
  createInstance,
  createTextInstance,
  resolveSingletonInstance,
  appendInitialChild,
  finalizeInitialChildren,
  supportsMutation,
  supportsPersistence,
  supportsResources,
  supportsSingletons,
  cloneInstance,
  cloneHiddenInstance,
  cloneHiddenTextInstance,
  createContainerChildSet,
  appendChildToContainerChildSet,
  finalizeContainerChildren,
  preparePortalMount,
  prepareScopeUpdate,
  maySuspendCommit,
  mayResourceSuspendCommit,
  preloadInstance,
  preloadResource,
} from './ReactFiberConfig';
import {
  getRootHostContainer,
  popHostContext,
  getHostContext,
  popHostContainer,
} from './ReactFiberHostContext';
import {
  suspenseStackCursor,
  popSuspenseListContext,
  popSuspenseHandler,
  pushSuspenseListContext,
  setShallowSuspenseListContext,
  ForceSuspenseFallback,
  setDefaultShallowSuspenseListContext,
} from './ReactFiberSuspenseContext';
import {popHiddenContext} from './ReactFiberHiddenContext';
import {findFirstSuspended} from './ReactFiberSuspenseComponent';
import {
  isContextProvider as isLegacyContextProvider,
  popContext as popLegacyContext,
  popTopLevelContextObject as popTopLevelLegacyContextObject,
} from './ReactFiberContext';
import {popProvider} from './ReactFiberNewContext';
import {
  prepareToHydrateHostInstance,
  prepareToHydrateHostTextInstance,
  prepareToHydrateHostSuspenseInstance,
  popHydrationState,
  resetHydrationState,
  getIsHydrating,
  upgradeHydrationErrorsToRecoverable,
  emitPendingHydrationWarnings,
} from './ReactFiberHydrationContext';
import {
  renderHasNotSuspendedYet,
  getRenderTargetTime,
  getWorkInProgressTransitions,
  shouldRemainOnPreviousScreen,
  markSpawnedRetryLane,
} from './ReactFiberWorkLoop';
import {
  OffscreenLane,
  SomeRetryLane,
  NoLanes,
  includesSomeLane,
  mergeLanes,
  claimNextRetryLane,
} from './ReactFiberLane';
import {resetChildFibers} from './ReactChildFiber';
import {createScopeInstance} from './ReactFiberScope';
import {transferActualDuration} from './ReactProfilerTimer';
import {popCacheProvider} from './ReactFiberCacheComponent';
import {popTreeContext} from './ReactFiberTreeContext';
import {popRootTransition, popTransition} from './ReactFiberTransition';
import {
  popMarkerInstance,
  popRootMarkerInstance,
} from './ReactFiberTracingMarkerComponent';
import {suspendCommit} from './ReactFiberThenable';

/**
 * Tag the fiber with an update effect. This turns a Placement into
 * a PlacementAndUpdate.
 */
function markUpdate(workInProgress: Fiber) {
  workInProgress.flags |= Update;
}

/**
 * Tag the fiber with Cloned in persistent mode to signal that
 * it received an update that requires a clone of the tree above.
 */
function markCloned(workInProgress: Fiber) {
  if (supportsPersistence && enablePersistedModeClonedFlag) {
    workInProgress.flags |= Cloned;
  }
}

/**
 * In persistent mode, return whether this update needs to clone the subtree.
 */
function doesRequireClone(current: null | Fiber, completedWork: Fiber) {
  const didBailout = current !== null && current.child === completedWork.child;
  if (didBailout) {
    return false;
  }

  if ((completedWork.flags & ChildDeletion) !== NoFlags) {
    return true;
  }

  // TODO: If we move the `doesRequireClone` call after `bubbleProperties`
  // then we only have to check the `completedWork.subtreeFlags`.
  let child = completedWork.child;
  while (child !== null) {
    const checkedFlags = enablePersistedModeClonedFlag
      ? Cloned | Visibility | Placement | ChildDeletion
      : MutationMask;
    if (
      (child.flags & checkedFlags) !== NoFlags ||
      (child.subtreeFlags & checkedFlags) !== NoFlags
    ) {
      return true;
    }
    child = child.sibling;
  }
  return false;
}

function appendAllChildren(
  parent: Instance,
  workInProgress: Fiber,
  needsVisibilityToggle: boolean,
  isHidden: boolean,
) {
  if (supportsMutation) {
    // We only have the top Fiber that was created but we need recurse down its
    // children to find all the terminal nodes.
    let node = workInProgress.child;
    while (node !== null) {
      if (node.tag === HostComponent || node.tag === HostText) {
        appendInitialChild(parent, node.stateNode);
      } else if (
        node.tag === HostPortal ||
        (supportsSingletons ? node.tag === HostSingleton : false)
      ) {
        // If we have a portal child, then we don't want to traverse
        // down its children. Instead, we'll get insertions from each child in
        // the portal directly.
        // If we have a HostSingleton it will be placed independently
      } else if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
      if (node === workInProgress) {
        return;
      }
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      while (node.sibling === null) {
        // $FlowFixMe[incompatible-use] found when upgrading Flow
        if (node.return === null || node.return === workInProgress) {
          return;
        }
        node = node.return;
      }
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      node.sibling.return = node.return;
      node = node.sibling;
    }
  } else if (supportsPersistence) {
    // We only have the top Fiber that was created but we need recurse down its
    // children to find all the terminal nodes.
    let node = workInProgress.child;
    while (node !== null) {
      if (node.tag === HostComponent) {
        let instance = node.stateNode;
        if (needsVisibilityToggle && isHidden) {
          // This child is inside a timed out tree. Hide it.
          const props = node.memoizedProps;
          const type = node.type;
          instance = cloneHiddenInstance(instance, type, props);
        }
        appendInitialChild(parent, instance);
      } else if (node.tag === HostText) {
        let instance = node.stateNode;
        if (needsVisibilityToggle && isHidden) {
          // This child is inside a timed out tree. Hide it.
          const text = node.memoizedProps;
          instance = cloneHiddenTextInstance(instance, text);
        }
        appendInitialChild(parent, instance);
      } else if (node.tag === HostPortal) {
        // If we have a portal child, then we don't want to traverse
        // down its children. Instead, we'll get insertions from each child in
        // the portal directly.
      } else if (
        node.tag === OffscreenComponent &&
        node.memoizedState !== null
      ) {
        // The children in this boundary are hidden. Toggle their visibility
        // before appending.
        const child = node.child;
        if (child !== null) {
          child.return = node;
        }
        appendAllChildren(
          parent,
          node,
          /* needsVisibilityToggle */ true,
          /* isHidden */ true,
        );
      } else if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
      if (node === workInProgress) {
        return;
      }
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      while (node.sibling === null) {
        // $FlowFixMe[incompatible-use] found when upgrading Flow
        if (node.return === null || node.return === workInProgress) {
          return;
        }
        node = node.return;
      }
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      node.sibling.return = node.return;
      node = node.sibling;
    }
  }
}

// An unfortunate fork of appendAllChildren because we have two different parent types.
function appendAllChildrenToContainer(
  containerChildSet: ChildSet,
  workInProgress: Fiber,
  needsVisibilityToggle: boolean,
  isHidden: boolean,
) {
  if (supportsPersistence) {
    // We only have the top Fiber that was created but we need recurse down its
    // children to find all the terminal nodes.
    let node = workInProgress.child;
    while (node !== null) {
      if (node.tag === HostComponent) {
        let instance = node.stateNode;
        if (needsVisibilityToggle && isHidden) {
          // This child is inside a timed out tree. Hide it.
          const props = node.memoizedProps;
          const type = node.type;
          instance = cloneHiddenInstance(instance, type, props);
        }
        appendChildToContainerChildSet(containerChildSet, instance);
      } else if (node.tag === HostText) {
        let instance = node.stateNode;
        if (needsVisibilityToggle && isHidden) {
          // This child is inside a timed out tree. Hide it.
          const text = node.memoizedProps;
          instance = cloneHiddenTextInstance(instance, text);
        }
        appendChildToContainerChildSet(containerChildSet, instance);
      } else if (node.tag === HostPortal) {
        // If we have a portal child, then we don't want to traverse
        // down its children. Instead, we'll get insertions from each child in
        // the portal directly.
      } else if (
        node.tag === OffscreenComponent &&
        node.memoizedState !== null
      ) {
        // The children in this boundary are hidden. Toggle their visibility
        // before appending.
        const child = node.child;
        if (child !== null) {
          child.return = node;
        }
        // If Offscreen is not in manual mode, detached tree is hidden from user space.
        const _needsVisibilityToggle = !isOffscreenManual(node);
        appendAllChildrenToContainer(
          containerChildSet,
          node,
          /* needsVisibilityToggle */ _needsVisibilityToggle,
          /* isHidden */ true,
        );
      } else if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
      node = (node: Fiber);
      if (node === workInProgress) {
        return;
      }
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      while (node.sibling === null) {
        // $FlowFixMe[incompatible-use] found when upgrading Flow
        if (node.return === null || node.return === workInProgress) {
          return;
        }
        node = node.return;
      }
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      node.sibling.return = node.return;
      node = node.sibling;
    }
  }
}

function updateHostContainer(current: null | Fiber, workInProgress: Fiber) {
  if (supportsPersistence) {
    if (doesRequireClone(current, workInProgress)) {
      const portalOrRoot: {
        containerInfo: Container,
        pendingChildren: ChildSet,
        ...
      } = workInProgress.stateNode;
      const container = portalOrRoot.containerInfo;
      const newChildSet = createContainerChildSet();
      // If children might have changed, we have to add them all to the set.
      appendAllChildrenToContainer(
        newChildSet,
        workInProgress,
        /* needsVisibilityToggle */ false,
        /* isHidden */ false,
      );
      portalOrRoot.pendingChildren = newChildSet;
      // Schedule an update on the container to swap out the container.
      markUpdate(workInProgress);
      finalizeContainerChildren(container, newChildSet);
    }
  }
}
/**
 * 在updateHostComponent内部，
 * 被处理完的props会被赋值给workInProgress.updateQueue，
 * 并最终会在commit阶段被渲染在页面上。
 * */
function updateHostComponent(
  current: Fiber,
  workInProgress: Fiber,
  type: Type,
  newProps: Props,
  renderLanes: Lanes,
) {
  if (supportsMutation) {
    // If we have an alternate, that means this is an update and we need to
    // schedule a side-effect to do the updates.
    const oldProps = current.memoizedProps;
    if (oldProps === newProps) {
      // In mutation mode, this is sufficient for a bailout because
      // we won't touch this node even if children changed.
      return;
    }

    markUpdate(workInProgress);
  } else if (supportsPersistence) {
    const currentInstance = current.stateNode;
    const oldProps = current.memoizedProps;
    // If there are no effects associated with this node, then none of our children had any updates.
    // This guarantees that we can reuse all of them.
    const requiresClone = doesRequireClone(current, workInProgress);
    if (!requiresClone && oldProps === newProps) {
      // No changes, just reuse the existing instance.
      // Note that this might release a previous clone.
      workInProgress.stateNode = currentInstance;
      return;
    }
    const currentHostContext = getHostContext();

    let newChildSet = null;
    if (requiresClone && passChildrenWhenCloningPersistedNodes) {
      markCloned(workInProgress);
      newChildSet = createContainerChildSet();
      // If children might have changed, we have to add them all to the set.
      appendAllChildrenToContainer(
        newChildSet,
        workInProgress,
        /* needsVisibilityToggle */ false,
        /* isHidden */ false,
      );
    }

    const newInstance = cloneInstance(
      currentInstance,
      type,
      oldProps,
      newProps,
      !requiresClone,
      newChildSet,
    );
    if (newInstance === currentInstance) {
      // No changes, just reuse the existing instance.
      // Note that this might release a previous clone.
      workInProgress.stateNode = currentInstance;
      return;
    } else {
      markCloned(workInProgress);
    }

    // Certain renderers require commit-time effects for initial mount.
    // (eg DOM renderer supports auto-focus for certain elements).
    // Make sure such renderers get scheduled for later work.
    if (
      finalizeInitialChildren(newInstance, type, newProps, currentHostContext)
    ) {
      markUpdate(workInProgress);
    }
    workInProgress.stateNode = newInstance;
    if (!requiresClone) {
      if (!enablePersistedModeClonedFlag) {
        // If there are no other effects in this tree, we need to flag this node as having one.
        // Even though we're not going to use it for anything.
        // Otherwise parents won't know that there are new children to propagate upwards.
        markUpdate(workInProgress);
      }
    } else if (!passChildrenWhenCloningPersistedNodes) {
      // If children have changed, we have to add them all to the set.
      appendAllChildren(
        newInstance,
        workInProgress,
        /* needsVisibilityToggle */ false,
        /* isHidden */ false,
      );
    }
  }
}

// This function must be called at the very end of the complete phase, because
// it might throw to suspend, and if the resource immediately loads, the work
// loop will resume rendering as if the work-in-progress completed. So it must
// fully complete.
// TODO: This should ideally move to begin phase, but currently the instance is
// not created until the complete phase. For our existing use cases, host nodes
// that suspend don't have children, so it doesn't matter. But that might not
// always be true in the future.
function preloadInstanceAndSuspendIfNeeded(
  workInProgress: Fiber,
  type: Type,
  props: Props,
  renderLanes: Lanes,
) {
  if (!maySuspendCommit(type, props)) {
    // If this flag was set previously, we can remove it. The flag
    // represents whether this particular set of props might ever need to
    // suspend. The safest thing to do is for maySuspendCommit to always
    // return true, but if the renderer is reasonably confident that the
    // underlying resource won't be evicted, it can return false as a
    // performance optimization.
    workInProgress.flags &= ~MaySuspendCommit;
    return;
  }

  // Mark this fiber with a flag. This gets set on all host instances
  // that might possibly suspend, even if they don't need to suspend
  // currently. We use this when revealing a prerendered tree, because
  // even though the tree has "mounted", its resources might not have
  // loaded yet.
  workInProgress.flags |= MaySuspendCommit;

  // preload the instance if necessary. Even if this is an urgent render there
  // could be benefits to preloading early.
  // @TODO we should probably do the preload in begin work
  const isReady = preloadInstance(type, props);
  if (!isReady) {
    if (shouldRemainOnPreviousScreen()) {
      workInProgress.flags |= ShouldSuspendCommit;
    } else {
      suspendCommit();
    }
  }
}

function preloadResourceAndSuspendIfNeeded(
  workInProgress: Fiber,
  resource: Resource,
  type: Type,
  props: Props,
  renderLanes: Lanes,
) {
  // This is a fork of preloadInstanceAndSuspendIfNeeded, but for resources.
  if (!mayResourceSuspendCommit(resource)) {
    workInProgress.flags &= ~MaySuspendCommit;
    return;
  }

  workInProgress.flags |= MaySuspendCommit;

  const isReady = preloadResource(resource);
  if (!isReady) {
    if (shouldRemainOnPreviousScreen()) {
      workInProgress.flags |= ShouldSuspendCommit;
    } else {
      suspendCommit();
    }
  }
}

function scheduleRetryEffect(
  workInProgress: Fiber,
  retryQueue: RetryQueue | null,
) {
  const wakeables = retryQueue;
  if (wakeables !== null) {
    // Schedule an effect to attach a retry listener to the promise.
    // TODO: Move to passive phase
    workInProgress.flags |= Update;
  }

  // Check if we need to schedule an immediate retry. This should happen
  // whenever we unwind a suspended tree without fully rendering its siblings;
  // we need to begin the retry so we can start prerendering them.
  //
  // We also use this mechanism for Suspensey Resources (e.g. stylesheets),
  // because those don't actually block the render phase, only the commit phase.
  // So we can start rendering even before the resources are ready.
  if (workInProgress.flags & ScheduleRetry) {
    const retryLane =
      // TODO: This check should probably be moved into claimNextRetryLane
      // I also suspect that we need some further consolidation of offscreen
      // and retry lanes.
      workInProgress.tag !== OffscreenComponent
        ? claimNextRetryLane()
        : OffscreenLane;
    workInProgress.lanes = mergeLanes(workInProgress.lanes, retryLane);

    // Track the lanes that have been scheduled for an immediate retry so that
    // we can mark them as suspended upon committing the root.
    if (enableSiblingPrerendering) {
      markSpawnedRetryLane(retryLane);
    }
  }
}

function updateHostText(
  current: Fiber,
  workInProgress: Fiber,
  oldText: string,
  newText: string,
) {
  if (supportsMutation) {
    // If the text differs, mark it as an update. All the work in done in commitWork.
    if (oldText !== newText) {
      markUpdate(workInProgress);
    }
  } else if (supportsPersistence) {
    if (oldText !== newText) {
      // If the text content differs, we'll create a new text instance for it.
      const rootContainerInstance = getRootHostContainer();
      const currentHostContext = getHostContext();
      markCloned(workInProgress);
      workInProgress.stateNode = createTextInstance(
        newText,
        rootContainerInstance,
        currentHostContext,
        workInProgress,
      );
      if (!enablePersistedModeClonedFlag) {
        // We'll have to mark it as having an effect, even though we won't use the effect for anything.
        // This lets the parents know that at least one of their children has changed.
        markUpdate(workInProgress);
      }
    } else {
      workInProgress.stateNode = current.stateNode;
    }
  }
}

function cutOffTailIfNeeded(
  renderState: SuspenseListRenderState,
  hasRenderedATailFallback: boolean,
) {
  if (getIsHydrating()) {
    // If we're hydrating, we should consume as many items as we can
    // so we don't leave any behind.
    return;
  }
  switch (renderState.tailMode) {
    case 'hidden': {
      // Any insertions at the end of the tail list after this point
      // should be invisible. If there are already mounted boundaries
      // anything before them are not considered for collapsing.
      // Therefore we need to go through the whole tail to find if
      // there are any.
      let tailNode = renderState.tail;
      let lastTailNode = null;
      while (tailNode !== null) {
        if (tailNode.alternate !== null) {
          lastTailNode = tailNode;
        }
        tailNode = tailNode.sibling;
      }
      // Next we're simply going to delete all insertions after the
      // last rendered item.
      if (lastTailNode === null) {
        // All remaining items in the tail are insertions.
        renderState.tail = null;
      } else {
        // Detach the insertion after the last node that was already
        // inserted.
        lastTailNode.sibling = null;
      }
      break;
    }
    case 'collapsed': {
      // Any insertions at the end of the tail list after this point
      // should be invisible. If there are already mounted boundaries
      // anything before them are not considered for collapsing.
      // Therefore we need to go through the whole tail to find if
      // there are any.
      let tailNode = renderState.tail;
      let lastTailNode = null;
      while (tailNode !== null) {
        if (tailNode.alternate !== null) {
          lastTailNode = tailNode;
        }
        tailNode = tailNode.sibling;
      }
      // Next we're simply going to delete all insertions after the
      // last rendered item.
      if (lastTailNode === null) {
        // All remaining items in the tail are insertions.
        if (!hasRenderedATailFallback && renderState.tail !== null) {
          // We suspended during the head. We want to show at least one
          // row at the tail. So we'll keep on and cut off the rest.
          renderState.tail.sibling = null;
        } else {
          renderState.tail = null;
        }
      } else {
        // Detach the insertion after the last node that was already
        // inserted.
        lastTailNode.sibling = null;
      }
      break;
    }
  }
}

function bubbleProperties(completedWork: Fiber) {
  const didBailout =
    completedWork.alternate !== null &&
    completedWork.alternate.child === completedWork.child;

  let newChildLanes: Lanes = NoLanes;
  let subtreeFlags = NoFlags;

  if (!didBailout) {
    // Bubble up the earliest expiration time.
    if (enableProfilerTimer && (completedWork.mode & ProfileMode) !== NoMode) {
      // In profiling mode, resetChildExpirationTime is also used to reset
      // profiler durations.
      let actualDuration = completedWork.actualDuration;
      let treeBaseDuration = ((completedWork.selfBaseDuration: any): number);

      let child = completedWork.child;
      while (child !== null) {
        newChildLanes = mergeLanes(
          newChildLanes,
          mergeLanes(child.lanes, child.childLanes),
        );

        subtreeFlags |= child.subtreeFlags;
        subtreeFlags |= child.flags;

        // When a fiber is cloned, its actualDuration is reset to 0. This value will
        // only be updated if work is done on the fiber (i.e. it doesn't bailout).
        // When work is done, it should bubble to the parent's actualDuration. If
        // the fiber has not been cloned though, (meaning no work was done), then
        // this value will reflect the amount of time spent working on a previous
        // render. In that case it should not bubble. We determine whether it was
        // cloned by comparing the child pointer.
        // $FlowFixMe[unsafe-addition] addition with possible null/undefined value
        actualDuration += child.actualDuration;

        // $FlowFixMe[unsafe-addition] addition with possible null/undefined value
        treeBaseDuration += child.treeBaseDuration;
        child = child.sibling;
      }

      completedWork.actualDuration = actualDuration;
      completedWork.treeBaseDuration = treeBaseDuration;
    } else {
      let child = completedWork.child;
      while (child !== null) {
        newChildLanes = mergeLanes(
          newChildLanes,
          mergeLanes(child.lanes, child.childLanes),
        );

        subtreeFlags |= child.subtreeFlags;
        subtreeFlags |= child.flags;

        // Update the return pointer so the tree is consistent. This is a code
        // smell because it assumes the commit phase is never concurrent with
        // the render phase. Will address during refactor to alternate model.
        child.return = completedWork;

        child = child.sibling;
      }
    }

    completedWork.subtreeFlags |= subtreeFlags;
  } else {
    // Bubble up the earliest expiration time.
    if (enableProfilerTimer && (completedWork.mode & ProfileMode) !== NoMode) {
      // In profiling mode, resetChildExpirationTime is also used to reset
      // profiler durations.
      let treeBaseDuration = ((completedWork.selfBaseDuration: any): number);

      let child = completedWork.child;
      while (child !== null) {
        newChildLanes = mergeLanes(
          newChildLanes,
          mergeLanes(child.lanes, child.childLanes),
        );

        // "Static" flags share the lifetime of the fiber/hook they belong to,
        // so we should bubble those up even during a bailout. All the other
        // flags have a lifetime only of a single render + commit, so we should
        // ignore them.
        subtreeFlags |= child.subtreeFlags & StaticMask;
        subtreeFlags |= child.flags & StaticMask;

        // $FlowFixMe[unsafe-addition] addition with possible null/undefined value
        treeBaseDuration += child.treeBaseDuration;
        child = child.sibling;
      }

      completedWork.treeBaseDuration = treeBaseDuration;
    } else {
      let child = completedWork.child;
      while (child !== null) {
        newChildLanes = mergeLanes(
          newChildLanes,
          mergeLanes(child.lanes, child.childLanes),
        );

        // "Static" flags share the lifetime of the fiber/hook they belong to,
        // so we should bubble those up even during a bailout. All the other
        // flags have a lifetime only of a single render + commit, so we should
        // ignore them.
        subtreeFlags |= child.subtreeFlags & StaticMask;
        subtreeFlags |= child.flags & StaticMask;

        // Update the return pointer so the tree is consistent. This is a code
        // smell because it assumes the commit phase is never concurrent with
        // the render phase. Will address during refactor to alternate model.
        child.return = completedWork;

        child = child.sibling;
      }
    }

    completedWork.subtreeFlags |= subtreeFlags;
  }

  completedWork.childLanes = newChildLanes;

  return didBailout;
}

function completeDehydratedSuspenseBoundary(
  current: Fiber | null,
  workInProgress: Fiber,
  nextState: SuspenseState | null,
): boolean {
  const wasHydrated = popHydrationState(workInProgress);

  if (nextState !== null && nextState.dehydrated !== null) {
    // We might be inside a hydration state the first time we're picking up this
    // Suspense boundary, and also after we've reentered it for further hydration.
    if (current === null) {
      if (!wasHydrated) {
        throw new Error(
          'A dehydrated suspense component was completed without a hydrated node. ' +
            'This is probably a bug in React.',
        );
      }
      prepareToHydrateHostSuspenseInstance(workInProgress);
      bubbleProperties(workInProgress);
      if (enableProfilerTimer) {
        if ((workInProgress.mode & ProfileMode) !== NoMode) {
          const isTimedOutSuspense = nextState !== null;
          if (isTimedOutSuspense) {
            // Don't count time spent in a timed out Suspense subtree as part of the base duration.
            const primaryChildFragment = workInProgress.child;
            if (primaryChildFragment !== null) {
              // $FlowFixMe[unsafe-arithmetic] Flow doesn't support type casting in combination with the -= operator
              workInProgress.treeBaseDuration -=
                ((primaryChildFragment.treeBaseDuration: any): number);
            }
          }
        }
      }
      return false;
    } else {
      emitPendingHydrationWarnings();
      // We might have reentered this boundary to hydrate it. If so, we need to reset the hydration
      // state since we're now exiting out of it. popHydrationState doesn't do that for us.
      resetHydrationState();
      if ((workInProgress.flags & DidCapture) === NoFlags) {
        // This boundary did not suspend so it's now hydrated and unsuspended.
        workInProgress.memoizedState = null;
      }
      // If nothing suspended, we need to schedule an effect to mark this boundary
      // as having hydrated so events know that they're free to be invoked.
      // It's also a signal to replay events and the suspense callback.
      // If something suspended, schedule an effect to attach retry listeners.
      // So we might as well always mark this.
      workInProgress.flags |= Update;
      bubbleProperties(workInProgress);
      if (enableProfilerTimer) {
        if ((workInProgress.mode & ProfileMode) !== NoMode) {
          const isTimedOutSuspense = nextState !== null;
          if (isTimedOutSuspense) {
            // Don't count time spent in a timed out Suspense subtree as part of the base duration.
            const primaryChildFragment = workInProgress.child;
            if (primaryChildFragment !== null) {
              // $FlowFixMe[unsafe-arithmetic] Flow doesn't support type casting in combination with the -= operator
              workInProgress.treeBaseDuration -=
                ((primaryChildFragment.treeBaseDuration: any): number);
            }
          }
        }
      }
      return false;
    }
  } else {
    // Successfully completed this tree. If this was a forced client render,
    // there may have been recoverable errors during first hydration
    // attempt. If so, add them to a queue so we can log them in the
    // commit phase.
    upgradeHydrationErrorsToRecoverable();

    // Fall through to normal Suspense path
    return true;
  }
}
/**
 * completeWork也是针对不同fiber.tag调用不同的处理逻辑。
 * */
function completeWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderLanes: Lanes,
): Fiber | null {
  const newProps = workInProgress.pendingProps;
  // Note: This intentionally doesn't check if we're hydrating because comparing
  // to the current tree provider fiber is just as fast and less error-prone.
  // Ideally we would have a special version of the work loop only
  // for hydration.
  popTreeContext(workInProgress);
  switch (workInProgress.tag) {
    case IncompleteFunctionComponent: {
      if (disableLegacyMode) {
        break;
      }
      // Fallthrough
    }
    case LazyComponent:
    case SimpleMemoComponent:
    case FunctionComponent:
    case ForwardRef:
    case Fragment:
    case Mode:
    case Profiler:
    case ContextConsumer:
    case MemoComponent:
      bubbleProperties(workInProgress);
      return null;
    case ClassComponent: {
      const Component = workInProgress.type;
      if (isLegacyContextProvider(Component)) {
        popLegacyContext(workInProgress);
      }
      bubbleProperties(workInProgress);
      return null;
    }
    case HostRoot: {
      const fiberRoot = (workInProgress.stateNode: FiberRoot);

      if (enableTransitionTracing) {
        const transitions = getWorkInProgressTransitions();
        // We set the Passive flag here because if there are new transitions,
        // we will need to schedule callbacks and process the transitions,
        // which we do in the passive phase
        if (transitions !== null) {
          workInProgress.flags |= Passive;
        }
      }

      if (enableCache) {
        let previousCache: Cache | null = null;
        if (current !== null) {
          previousCache = current.memoizedState.cache;
        }
        const cache: Cache = workInProgress.memoizedState.cache;
        if (cache !== previousCache) {
          // Run passive effects to retain/release the cache.
          workInProgress.flags |= Passive;
        }
        popCacheProvider(workInProgress, cache);
      }

      if (enableTransitionTracing) {
        popRootMarkerInstance(workInProgress);
      }

      popRootTransition(workInProgress, fiberRoot, renderLanes);
      popHostContainer(workInProgress);
      popTopLevelLegacyContextObject(workInProgress);
      if (fiberRoot.pendingContext) {
        fiberRoot.context = fiberRoot.pendingContext;
        fiberRoot.pendingContext = null;
      }
      if (current === null || current.child === null) {
        // If we hydrated, pop so that we can delete any remaining children
        // that weren't hydrated.
        const wasHydrated = popHydrationState(workInProgress);
        if (wasHydrated) {
          emitPendingHydrationWarnings();
          // If we hydrated, then we'll need to schedule an update for
          // the commit side-effects on the root.
          markUpdate(workInProgress);
        } else {
          if (current !== null) {
            const prevState: RootState = current.memoizedState;
            if (
              // Check if this is a client root
              !prevState.isDehydrated ||
              // Check if we reverted to client rendering (e.g. due to an error)
              (workInProgress.flags & ForceClientRender) !== NoFlags
            ) {
              // Schedule an effect to clear this container at the start of the
              // next commit. This handles the case of React rendering into a
              // container with previous children. It's also safe to do for
              // updates too, because current.child would only be null if the
              // previous render was null (so the container would already
              // be empty).
              workInProgress.flags |= Snapshot;

              // If this was a forced client render, there may have been
              // recoverable errors during first hydration attempt. If so, add
              // them to a queue so we can log them in the commit phase.
              upgradeHydrationErrorsToRecoverable();
            }
          }
        }
      }
      updateHostContainer(current, workInProgress);
      bubbleProperties(workInProgress);
      if (enableTransitionTracing) {
        if ((workInProgress.subtreeFlags & Visibility) !== NoFlags) {
          // If any of our suspense children toggle visibility, this means that
          // the pending boundaries array needs to be updated, which we only
          // do in the passive phase.
          workInProgress.flags |= Passive;
        }
      }
      return null;
    }
    case HostHoistable: {
      if (supportsResources) {
        // The branching here is more complicated than you might expect because
        // a HostHoistable sometimes corresponds to a Resource and sometimes
        // corresponds to an Instance. It can also switch during an update.

        const type = workInProgress.type;
        const nextResource: Resource | null = workInProgress.memoizedState;
        if (current === null) {
          // We are mounting and must Update this Hoistable in this commit
          // @TODO refactor this block to create the instance here in complete
          // phase if we are not hydrating.
          markUpdate(workInProgress);
          if (nextResource !== null) {
            // This is a Hoistable Resource

            // This must come at the very end of the complete phase.
            bubbleProperties(workInProgress);
            preloadResourceAndSuspendIfNeeded(
              workInProgress,
              nextResource,
              type,
              newProps,
              renderLanes,
            );
            return null;
          } else {
            // This is a Hoistable Instance
            // This must come at the very end of the complete phase.
            bubbleProperties(workInProgress);
            preloadInstanceAndSuspendIfNeeded(
              workInProgress,
              type,
              newProps,
              renderLanes,
            );
            return null;
          }
        } else {
          // This is an update.
          if (nextResource) {
            // This is a Resource
            if (nextResource !== current.memoizedState) {
              // we have a new Resource. we need to update
              markUpdate(workInProgress);
              // This must come at the very end of the complete phase.
              bubbleProperties(workInProgress);
              // This must come at the very end of the complete phase, because it might
              // throw to suspend, and if the resource immediately loads, the work loop
              // will resume rendering as if the work-in-progress completed. So it must
              // fully complete.
              preloadResourceAndSuspendIfNeeded(
                workInProgress,
                nextResource,
                type,
                newProps,
                renderLanes,
              );
              return null;
            } else {
              // This must come at the very end of the complete phase.
              bubbleProperties(workInProgress);
              workInProgress.flags &= ~MaySuspendCommit;
              return null;
            }
          } else {
            // This is an Instance
            // We may have props to update on the Hoistable instance.
            if (supportsMutation) {
              const oldProps = current.memoizedProps;
              if (oldProps !== newProps) {
                markUpdate(workInProgress);
              }
            } else {
              // 当update时，Fiber节点已经存在对应DOM节点，所以不需要生成DOM节点。需要做的主要是处理props，
              updateHostComponent(
                current,
                workInProgress,
                type,
                newProps,
                renderLanes,
              );
            }
            // This must come at the very end of the complete phase.
            bubbleProperties(workInProgress);
            preloadInstanceAndSuspendIfNeeded(
              workInProgress,
              type,
              newProps,
              renderLanes,
            );
            return null;
          }
        }
      }
      // Fall through
    }
    case HostSingleton: {
      if (supportsSingletons) {
        popHostContext(workInProgress);
        const rootContainerInstance = getRootHostContainer();
        const type = workInProgress.type;
        if (current !== null && workInProgress.stateNode != null) {
          if (supportsMutation) {
            const oldProps = current.memoizedProps;
            if (oldProps !== newProps) {
              markUpdate(workInProgress);
            }
          } else {
            updateHostComponent(
              current,
              workInProgress,
              type,
              newProps,
              renderLanes,
            );
          }
        } else {
          if (!newProps) {
            if (workInProgress.stateNode === null) {
              throw new Error(
                'We must have new props for new mounts. This error is likely ' +
                  'caused by a bug in React. Please file an issue.',
              );
            }

            // This can happen when we abort work.
            bubbleProperties(workInProgress);
            return null;
          }

          const currentHostContext = getHostContext();
          const wasHydrated = popHydrationState(workInProgress);
          let instance: Instance;
          if (wasHydrated) {
            // We ignore the boolean indicating there is an updateQueue because
            // it is used only to set text children and HostSingletons do not
            // use them.
            prepareToHydrateHostInstance(workInProgress, currentHostContext);
            instance = workInProgress.stateNode;
          } else {
            instance = resolveSingletonInstance(
              type,
              newProps,
              rootContainerInstance,
              currentHostContext,
              true,
            );
            workInProgress.stateNode = instance;
            markUpdate(workInProgress);
          }
        }
        bubbleProperties(workInProgress);
        return null;
      }
      // Fall through
    }
    case HostComponent: { // TODO 🚨 重点关注页面渲染所必须的HostComponent(即原生DOM组件对应的Fiber节点
      popHostContext(workInProgress);
      const type = workInProgress.type;
      // 同时针对HostComponent，
      // 判断update时我们还需要考
      // 虑workInProgress.stateNode != null ?（即该Fiber节点是否存在对应的DOM节点）
      // stateNode：存储与当前 Fiber 节点相关的实例或 DOM 节点
      /**
       * stateNode 是 Fiber 对象的一个属性，其值取决于 Fiber 节点的类型：
       *
       * 类组件：stateNode 是该类组件的实例对象（即 this）。
       * 函数组件：函数组件没有实例，因此 stateNode 通常为 null。
       * DOM 节点：stateNode 是该 Fiber 节点对应的 DOM 元素。
       * */
      if (current !== null && workInProgress.stateNode != null) {
        // TODO 当update时，Fiber节点已经存在对应DOM节点，所以不需要生成DOM节点。需要做的主要是处理props，比如：
        /**
         * onClick、onChange等回调函数的注册
         * 处理style prop
         * 处理DANGEROUSLY_SET_INNER_HTML prop
         * 处理children prop
         * */
        updateHostComponent(
          current,
          workInProgress,
          type,
          newProps,
          renderLanes,
        );
      } else {
        const currentHostContext = getHostContext();
        const wasHydrated = popHydrationState(workInProgress);
        if (wasHydrated) {
          prepareToHydrateHostInstance(workInProgress, currentHostContext);
        } else {
          const rootContainerInstance = getRootHostContainer();
          // // 为fiber创建对应DOM节点
          const instance = createInstance(
            type,
            newProps,
            rootContainerInstance,
            currentHostContext,
            workInProgress,
          );
          markCloned(workInProgress);
          // 将子孙DOM节点插入刚生成的DOM节点中
          /**
           * 由于completeWork属于“归”阶段调用的函数，
           * 每次调用appendAllChildren时都会将已生成的子孙DOM节点插入当前生成的DOM节点下。
           * 那么当“归”到rootFiber时，我们已经有一个构建好的离屏DOM树
           * */
          appendAllChildren(instance, workInProgress, false, false);
          workInProgress.stateNode = instance;
          if (
            finalizeInitialChildren(
              instance,
              type,
              newProps,
              currentHostContext,
            )
          ) {
            markUpdate(workInProgress);
          }
        }
      }
      bubbleProperties(workInProgress);
      preloadInstanceAndSuspendIfNeeded(
        workInProgress,
        workInProgress.type,
        workInProgress.pendingProps,
        renderLanes,
      );
      return null;
    }
    case HostText: {
      const newText = newProps;
      if (current && workInProgress.stateNode != null) {
        const oldText = current.memoizedProps;
        updateHostText(current, workInProgress, oldText, newText);
      } else {
        if (typeof newText !== 'string') {
          if (workInProgress.stateNode === null) {
            throw new Error(
              'We must have new props for new mounts. This error is likely ' +
                'caused by a bug in React. Please file an issue.',
            );
          }
          // This can happen when we abort work.
        }
        const rootContainerInstance = getRootHostContainer();
        const currentHostContext = getHostContext();
        const wasHydrated = popHydrationState(workInProgress);
        if (wasHydrated) {
          prepareToHydrateHostTextInstance(workInProgress);
        } else {
          markCloned(workInProgress);
          workInProgress.stateNode = createTextInstance(
            newText,
            rootContainerInstance,
            currentHostContext,
            workInProgress,
          );
        }
      }
      bubbleProperties(workInProgress);
      return null;
    }
    case SuspenseComponent: {
      const nextState: null | SuspenseState = workInProgress.memoizedState;

      // Special path for dehydrated boundaries. We may eventually move this
      // to its own fiber type so that we can add other kinds of hydration
      // boundaries that aren't associated with a Suspense tree. In anticipation
      // of such a refactor, all the hydration logic is contained in
      // this branch.
      if (
        current === null ||
        (current.memoizedState !== null &&
          current.memoizedState.dehydrated !== null)
      ) {
        const fallthroughToNormalSuspensePath =
          completeDehydratedSuspenseBoundary(
            current,
            workInProgress,
            nextState,
          );
        if (!fallthroughToNormalSuspensePath) {
          if (workInProgress.flags & ForceClientRender) {
            popSuspenseHandler(workInProgress);
            // Special case. There were remaining unhydrated nodes. We treat
            // this as a mismatch. Revert to client rendering.
            return workInProgress;
          } else {
            popSuspenseHandler(workInProgress);
            // Did not finish hydrating, either because this is the initial
            // render or because something suspended.
            return null;
          }
        }

        // Continue with the normal Suspense path.
      }

      popSuspenseHandler(workInProgress);

      if ((workInProgress.flags & DidCapture) !== NoFlags) {
        // Something suspended. Re-render with the fallback children.
        workInProgress.lanes = renderLanes;
        // Do not reset the effect list.
        if (
          enableProfilerTimer &&
          (workInProgress.mode & ProfileMode) !== NoMode
        ) {
          transferActualDuration(workInProgress);
        }
        // Don't bubble properties in this case.
        return workInProgress;
      }

      const nextDidTimeout = nextState !== null;
      const prevDidTimeout =
        current !== null &&
        (current.memoizedState: null | SuspenseState) !== null;

      if (enableCache && nextDidTimeout) {
        const offscreenFiber: Fiber = (workInProgress.child: any);
        let previousCache: Cache | null = null;
        if (
          offscreenFiber.alternate !== null &&
          offscreenFiber.alternate.memoizedState !== null &&
          offscreenFiber.alternate.memoizedState.cachePool !== null
        ) {
          previousCache = offscreenFiber.alternate.memoizedState.cachePool.pool;
        }
        let cache: Cache | null = null;
        if (
          offscreenFiber.memoizedState !== null &&
          offscreenFiber.memoizedState.cachePool !== null
        ) {
          cache = offscreenFiber.memoizedState.cachePool.pool;
        }
        if (cache !== previousCache) {
          offscreenFiber.flags |= Passive;
        }
      }

      if (nextDidTimeout !== prevDidTimeout) {
        if (enableTransitionTracing) {
          const offscreenFiber: Fiber = (workInProgress.child: any);
          offscreenFiber.flags |= Passive;
        }
        if (nextDidTimeout) {
          const offscreenFiber: Fiber = (workInProgress.child: any);
          offscreenFiber.flags |= Visibility;
        }
      }

      const retryQueue: RetryQueue | null = (workInProgress.updateQueue: any);
      scheduleRetryEffect(workInProgress, retryQueue);

      if (
        enableSuspenseCallback &&
        workInProgress.updateQueue !== null &&
        workInProgress.memoizedProps.suspenseCallback != null
      ) {
        // Always notify the callback
        // TODO: Move to passive phase
        workInProgress.flags |= Update;
      }
      bubbleProperties(workInProgress);
      if (enableProfilerTimer) {
        if ((workInProgress.mode & ProfileMode) !== NoMode) {
          if (nextDidTimeout) {
            // Don't count time spent in a timed out Suspense subtree as part of the base duration.
            const primaryChildFragment = workInProgress.child;
            if (primaryChildFragment !== null) {
              // $FlowFixMe[unsafe-arithmetic] Flow doesn't support type casting in combination with the -= operator
              workInProgress.treeBaseDuration -=
                ((primaryChildFragment.treeBaseDuration: any): number);
            }
          }
        }
      }
      return null;
    }
    case HostPortal:
      popHostContainer(workInProgress);
      updateHostContainer(current, workInProgress);
      if (current === null) {
        preparePortalMount(workInProgress.stateNode.containerInfo);
      }
      bubbleProperties(workInProgress);
      return null;
    case ContextProvider:
      // Pop provider fiber
      let context: ReactContext<any>;
      if (enableRenderableContext) {
        context = workInProgress.type;
      } else {
        context = workInProgress.type._context;
      }
      popProvider(context, workInProgress);
      bubbleProperties(workInProgress);
      return null;
    case IncompleteClassComponent: {
      if (disableLegacyMode) {
        break;
      }
      // Same as class component case. I put it down here so that the tags are
      // sequential to ensure this switch is compiled to a jump table.
      const Component = workInProgress.type;
      if (isLegacyContextProvider(Component)) {
        popLegacyContext(workInProgress);
      }
      bubbleProperties(workInProgress);
      return null;
    }
    case SuspenseListComponent: {
      popSuspenseListContext(workInProgress);

      const renderState: null | SuspenseListRenderState =
        workInProgress.memoizedState;

      if (renderState === null) {
        // We're running in the default, "independent" mode.
        // We don't do anything in this mode.
        bubbleProperties(workInProgress);
        return null;
      }

      let didSuspendAlready = (workInProgress.flags & DidCapture) !== NoFlags;

      const renderedTail = renderState.rendering;
      if (renderedTail === null) {
        // We just rendered the head.
        if (!didSuspendAlready) {
          // This is the first pass. We need to figure out if anything is still
          // suspended in the rendered set.

          // If new content unsuspended, but there's still some content that
          // didn't. Then we need to do a second pass that forces everything
          // to keep showing their fallbacks.

          // We might be suspended if something in this render pass suspended, or
          // something in the previous committed pass suspended. Otherwise,
          // there's no chance so we can skip the expensive call to
          // findFirstSuspended.
          const cannotBeSuspended =
            renderHasNotSuspendedYet() &&
            (current === null || (current.flags & DidCapture) === NoFlags);
          if (!cannotBeSuspended) {
            let row = workInProgress.child;
            while (row !== null) {
              const suspended = findFirstSuspended(row);
              if (suspended !== null) {
                didSuspendAlready = true;
                workInProgress.flags |= DidCapture;
                cutOffTailIfNeeded(renderState, false);

                // If this is a newly suspended tree, it might not get committed as
                // part of the second pass. In that case nothing will subscribe to
                // its thenables. Instead, we'll transfer its thenables to the
                // SuspenseList so that it can retry if they resolve.
                // There might be multiple of these in the list but since we're
                // going to wait for all of them anyway, it doesn't really matter
                // which ones gets to ping. In theory we could get clever and keep
                // track of how many dependencies remain but it gets tricky because
                // in the meantime, we can add/remove/change items and dependencies.
                // We might bail out of the loop before finding any but that
                // doesn't matter since that means that the other boundaries that
                // we did find already has their listeners attached.
                const retryQueue: RetryQueue | null =
                  (suspended.updateQueue: any);
                workInProgress.updateQueue = retryQueue;
                scheduleRetryEffect(workInProgress, retryQueue);

                // Rerender the whole list, but this time, we'll force fallbacks
                // to stay in place.
                // Reset the effect flags before doing the second pass since that's now invalid.
                // Reset the child fibers to their original state.
                workInProgress.subtreeFlags = NoFlags;
                resetChildFibers(workInProgress, renderLanes);

                // Set up the Suspense List Context to force suspense and
                // immediately rerender the children.
                pushSuspenseListContext(
                  workInProgress,
                  setShallowSuspenseListContext(
                    suspenseStackCursor.current,
                    ForceSuspenseFallback,
                  ),
                );
                // Don't bubble properties in this case.
                return workInProgress.child;
              }
              row = row.sibling;
            }
          }

          if (renderState.tail !== null && now() > getRenderTargetTime()) {
            // We have already passed our CPU deadline but we still have rows
            // left in the tail. We'll just give up further attempts to render
            // the main content and only render fallbacks.
            workInProgress.flags |= DidCapture;
            didSuspendAlready = true;

            cutOffTailIfNeeded(renderState, false);

            // Since nothing actually suspended, there will nothing to ping this
            // to get it started back up to attempt the next item. While in terms
            // of priority this work has the same priority as this current render,
            // it's not part of the same transition once the transition has
            // committed. If it's sync, we still want to yield so that it can be
            // painted. Conceptually, this is really the same as pinging.
            // We can use any RetryLane even if it's the one currently rendering
            // since we're leaving it behind on this node.
            workInProgress.lanes = SomeRetryLane;
          }
        } else {
          cutOffTailIfNeeded(renderState, false);
        }
        // Next we're going to render the tail.
      } else {
        // Append the rendered row to the child list.
        if (!didSuspendAlready) {
          const suspended = findFirstSuspended(renderedTail);
          if (suspended !== null) {
            workInProgress.flags |= DidCapture;
            didSuspendAlready = true;

            // Ensure we transfer the update queue to the parent so that it doesn't
            // get lost if this row ends up dropped during a second pass.
            const retryQueue: RetryQueue | null = (suspended.updateQueue: any);
            workInProgress.updateQueue = retryQueue;
            scheduleRetryEffect(workInProgress, retryQueue);

            cutOffTailIfNeeded(renderState, true);
            // This might have been modified.
            if (
              renderState.tail === null &&
              renderState.tailMode === 'hidden' &&
              !renderedTail.alternate &&
              !getIsHydrating() // We don't cut it if we're hydrating.
            ) {
              // We're done.
              bubbleProperties(workInProgress);
              return null;
            }
          } else if (
            // The time it took to render last row is greater than the remaining
            // time we have to render. So rendering one more row would likely
            // exceed it.
            now() * 2 - renderState.renderingStartTime >
              getRenderTargetTime() &&
            renderLanes !== OffscreenLane
          ) {
            // We have now passed our CPU deadline and we'll just give up further
            // attempts to render the main content and only render fallbacks.
            // The assumption is that this is usually faster.
            workInProgress.flags |= DidCapture;
            didSuspendAlready = true;

            cutOffTailIfNeeded(renderState, false);

            // Since nothing actually suspended, there will nothing to ping this
            // to get it started back up to attempt the next item. While in terms
            // of priority this work has the same priority as this current render,
            // it's not part of the same transition once the transition has
            // committed. If it's sync, we still want to yield so that it can be
            // painted. Conceptually, this is really the same as pinging.
            // We can use any RetryLane even if it's the one currently rendering
            // since we're leaving it behind on this node.
            workInProgress.lanes = SomeRetryLane;
          }
        }
        if (renderState.isBackwards) {
          // The effect list of the backwards tail will have been added
          // to the end. This breaks the guarantee that life-cycles fire in
          // sibling order but that isn't a strong guarantee promised by React.
          // Especially since these might also just pop in during future commits.
          // Append to the beginning of the list.
          renderedTail.sibling = workInProgress.child;
          workInProgress.child = renderedTail;
        } else {
          const previousSibling = renderState.last;
          if (previousSibling !== null) {
            previousSibling.sibling = renderedTail;
          } else {
            workInProgress.child = renderedTail;
          }
          renderState.last = renderedTail;
        }
      }

      if (renderState.tail !== null) {
        // We still have tail rows to render.
        // Pop a row.
        const next = renderState.tail;
        renderState.rendering = next;
        renderState.tail = next.sibling;
        renderState.renderingStartTime = now();
        next.sibling = null;

        // Restore the context.
        // TODO: We can probably just avoid popping it instead and only
        // setting it the first time we go from not suspended to suspended.
        let suspenseContext = suspenseStackCursor.current;
        if (didSuspendAlready) {
          suspenseContext = setShallowSuspenseListContext(
            suspenseContext,
            ForceSuspenseFallback,
          );
        } else {
          suspenseContext =
            setDefaultShallowSuspenseListContext(suspenseContext);
        }
        pushSuspenseListContext(workInProgress, suspenseContext);
        // Do a pass over the next row.
        // Don't bubble properties in this case.
        return next;
      }
      bubbleProperties(workInProgress);
      return null;
    }
    case ScopeComponent: {
      if (enableScopeAPI) {
        if (current === null) {
          const scopeInstance: ReactScopeInstance = createScopeInstance();
          workInProgress.stateNode = scopeInstance;
          prepareScopeUpdate(scopeInstance, workInProgress);
          if (workInProgress.ref !== null) {
            // Scope components always do work in the commit phase if there's a
            // ref attached.
            markUpdate(workInProgress);
          }
        } else {
          if (workInProgress.ref !== null) {
            // Scope components always do work in the commit phase if there's a
            // ref attached.
            markUpdate(workInProgress);
          }
        }
        bubbleProperties(workInProgress);
        return null;
      }
      break;
    }
    case OffscreenComponent:
    case LegacyHiddenComponent: {
      popSuspenseHandler(workInProgress);
      popHiddenContext(workInProgress);
      const nextState: OffscreenState | null = workInProgress.memoizedState;
      const nextIsHidden = nextState !== null;

      // Schedule a Visibility effect if the visibility has changed
      if (enableLegacyHidden && workInProgress.tag === LegacyHiddenComponent) {
        // LegacyHidden doesn't do any hiding — it only pre-renders.
      } else {
        if (current !== null) {
          const prevState: OffscreenState | null = current.memoizedState;
          const prevIsHidden = prevState !== null;
          if (prevIsHidden !== nextIsHidden) {
            workInProgress.flags |= Visibility;
          }
        } else {
          // On initial mount, we only need a Visibility effect if the tree
          // is hidden.
          if (nextIsHidden) {
            workInProgress.flags |= Visibility;
          }
        }
      }

      if (
        !nextIsHidden ||
        (!disableLegacyMode &&
          (workInProgress.mode & ConcurrentMode) === NoMode)
      ) {
        bubbleProperties(workInProgress);
      } else {
        // Don't bubble properties for hidden children unless we're rendering
        // at offscreen priority.
        if (
          includesSomeLane(renderLanes, (OffscreenLane: Lane)) &&
          // Also don't bubble if the tree suspended
          (workInProgress.flags & DidCapture) === NoLanes
        ) {
          bubbleProperties(workInProgress);
          // Check if there was an insertion or update in the hidden subtree.
          // If so, we need to hide those nodes in the commit phase, so
          // schedule a visibility effect.
          if (
            (!enableLegacyHidden ||
              workInProgress.tag !== LegacyHiddenComponent) &&
            workInProgress.subtreeFlags & (Placement | Update)
          ) {
            workInProgress.flags |= Visibility;
          }
        }
      }

      const offscreenQueue: OffscreenQueue | null =
        (workInProgress.updateQueue: any);
      if (offscreenQueue !== null) {
        const retryQueue = offscreenQueue.retryQueue;
        scheduleRetryEffect(workInProgress, retryQueue);
      }

      if (enableCache) {
        let previousCache: Cache | null = null;
        if (
          current !== null &&
          current.memoizedState !== null &&
          current.memoizedState.cachePool !== null
        ) {
          previousCache = current.memoizedState.cachePool.pool;
        }
        let cache: Cache | null = null;
        if (
          workInProgress.memoizedState !== null &&
          workInProgress.memoizedState.cachePool !== null
        ) {
          cache = workInProgress.memoizedState.cachePool.pool;
        }
        if (cache !== previousCache) {
          // Run passive effects to retain/release the cache.
          workInProgress.flags |= Passive;
        }
      }

      popTransition(workInProgress, current);

      return null;
    }
    case CacheComponent: {
      if (enableCache) {
        let previousCache: Cache | null = null;
        if (current !== null) {
          previousCache = current.memoizedState.cache;
        }
        const cache: Cache = workInProgress.memoizedState.cache;
        if (cache !== previousCache) {
          // Run passive effects to retain/release the cache.
          workInProgress.flags |= Passive;
        }
        popCacheProvider(workInProgress, cache);
        bubbleProperties(workInProgress);
      }
      return null;
    }
    case TracingMarkerComponent: {
      if (enableTransitionTracing) {
        const instance: TracingMarkerInstance | null = workInProgress.stateNode;
        if (instance !== null) {
          popMarkerInstance(workInProgress);
        }
        bubbleProperties(workInProgress);
      }
      return null;
    }
    case Throw: {
      if (!disableLegacyMode) {
        // Only Legacy Mode completes an errored node.
        return null;
      }
    }
  }

  throw new Error(
    `Unknown unit of work tag (${workInProgress.tag}). This error is likely caused by a bug in ` +
      'React. Please file an issue.',
  );
}

export {completeWork};
